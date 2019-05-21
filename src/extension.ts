/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as Core from 'vscode-chrome-debug-core';
import * as nls from 'vscode-nls';
import * as net from 'net';

import { defaultTargetFilter, getTargetFilter } from './utils';

import * as os from 'os';
import * as path from 'path';
import { ChromeDebugSession, logger, OnlyProvideCustomLauncherExtensibilityPoints, ISourcesRetriever, telemetry, UrlPathTransformer, TYPES, interfaces, GetComponentByID, DependencyInjection, UninitializedCDA } from 'vscode-chrome-debug-core';
import { ChromeDebugAdapter } from './chromeDebugAdapter';
import { ChromeLauncher } from './launcherAndRuner/chromeLauncher';
import { ChromeRunner } from './launcherAndRuner/chromeRunner';
import { ArgumentsUpdater } from './argumentsUpdater';
import { HTMLSourceRetriever } from './components/htmlSourceLogic';
import { CDTPResourceContentGetter } from './cdtpComponents/cdtpResourceContentGetter';
import { ShowOverlayWhenPaused, CDTPDeprecatedPage } from './features/showOverlayWhenPaused';
import { CustomizedUninitializedCDA } from './components/customizedUninitializedCDA';
import { customizeComponents } from './chromeDebug';

const EXTENSION_NAME = 'debugger-for-chrome';

// Start a ChromeDebugSession configured to only match 'page' targets, which are Chrome tabs.
// Cast because DebugSession is declared twice - in this repo's vscode-debugadapter, and that of -core... TODO
const logFilePath = path.resolve(os.tmpdir(), 'vscode-chrome-debug.txt');

const localize = nls.loadMessageBundle();

const EMBED_DEBUG_ADAPTER = true;

export function activate(context: vscode.ExtensionContext) {

    context.subscriptions.push(vscode.commands.registerCommand('extension.chrome-debug.toggleSkippingFile', toggleSkippingFile));
    context.subscriptions.push(vscode.commands.registerCommand('extension.chrome-debug.toggleSmartStep', toggleSmartStep));

    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('chrome', new ChromeConfigurationProvider()));

    if (EMBED_DEBUG_ADAPTER) {
        const factory = new DebugAdapterDescriptorFactory();
        context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('chrome', factory));
        context.subscriptions.push(factory);
    }
}

export function deactivate() {
}

const DEFAULT_CONFIG = {
    type: 'chrome',
    request: 'launch',
    name: localize('chrome.launch.name', 'Launch Chrome against localhost'),
    url: 'http://localhost:8080',
    webRoot: '${workspaceFolder}'
};

export class ChromeConfigurationProvider implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(_folder: vscode.WorkspaceFolder | undefined, _token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return Promise.resolve([DEFAULT_CONFIG]);
    }

    /**
     * Try to add all missing attributes to the debug configuration being launched.
     */
    async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, _token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null> {
        // if launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            // Return null so it will create a launch.json and fall back on provideDebugConfigurations - better to point the user towards the config
            // than try to work automagically.
            return null;
        }

        if (config.request === 'attach') {
            const discovery = new Core.chromeTargetDiscoveryStrategy.ChromeTargetDiscovery(
                new Core.NullLogger(), new Core.telemetry.NullTelemetryReporter());

            let targets;
            try {
                targets = await discovery.getAllTargets(config.address || '127.0.0.1', config.port, config.targetTypes === undefined ? defaultTargetFilter : getTargetFilter(config.targetTypes), config.url || config.urlFilter);
            } catch (e) {
                // Target not running?
            }

            if (targets && targets.length > 1) {
                const selectedTarget = await pickTarget(targets);
                if (!selectedTarget) {
                    // Quickpick canceled, bail
                    return null;
                }

                config.websocketUrl = selectedTarget.websocketDebuggerUrl;
            }
        }

        return config;
    }
}

function toggleSkippingFile(path: string | undefined): void {
    if (!path) {
        const activeEditor = vscode.window.activeTextEditor;
        path = activeEditor && activeEditor.document.fileName;
    }

    if (path && vscode.debug.activeDebugSession) {
        const args: Core.IToggleSkipFileStatusArgs = typeof path === 'string' ? { path: path } : { sourceReference: path };
        vscode.debug.activeDebugSession.customRequest('toggleSkipFileStatus', args);
    }
}

function toggleSmartStep(): void {
    if (vscode.debug.activeDebugSession) {
        vscode.debug.activeDebugSession.customRequest('toggleSmartStep');
    }
}

interface ITargetQuickPickItem extends vscode.QuickPickItem {
    websocketDebuggerUrl: string;
}

async function pickTarget(targets: Core.chromeConnection.ITarget[]): Promise<ITargetQuickPickItem | undefined> {
    const items = targets.map(target => (<ITargetQuickPickItem>{
        label: unescapeTargetTitle(target.title),
        detail: target.url,
        websocketDebuggerUrl: target.webSocketDebuggerUrl
    }));

    const placeHolder = localize('chrome.targets.placeholder', 'Select a tab');
    const selected = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
    return selected;
}

function unescapeTargetTitle(title: string): string {
    return title
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, `'`)
        .replace(/&quot;/g, '"');
}

class DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

    private server?: net.Server;

    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

        if (!this.server) {
            // start listening on a random port
            this.server = net.createServer(socket => {
                logger.verbose('-------------------Starting new (embedded) debug session------------------');

                // This class specifies the customizations that chrome-debug does to -core
                const extensibilityPoints = new OnlyProvideCustomLauncherExtensibilityPoints(logFilePath, ChromeLauncher, ChromeRunner, customizeComponents);
                extensibilityPoints.updateArguments = (scenario, args) => new ArgumentsUpdater().updateArguments(scenario, args);
                extensibilityPoints.targetFilter = defaultTargetFilter;
                extensibilityPoints.pathTransformer = UrlPathTransformer;
                extensibilityPoints.bindAdditionalComponents = (diContainer: DependencyInjection) => {
                    diContainer.configureClass(TYPES.IServiceComponent, ShowOverlayWhenPaused);
                    diContainer.configureClass(CDTPDeprecatedPage, CDTPDeprecatedPage);
                };

                console.error('>> accepted connection from client');
                socket.on('end', () => {
                    console.error('>> client connection closed\n');
                });

                const session = new ChromeDebugSession(false, true, {
                    adapter: ChromeDebugAdapter,
                    extensionName: EXTENSION_NAME,
                    logFilePath: logFilePath,
                    extensibilityPoints: extensibilityPoints
                });

                session.setRunAsServer(true);
                session.start(socket, socket);

                /* tslint:disable:no-var-requires */
                const debugAdapterVersion = require('../../package.json').version;
                logger.log(EXTENSION_NAME + ': ' + debugAdapterVersion);

                /* __GDPR__FRAGMENT__
                    "DebugCommonProperties" : {
                        "Versions.DebugAdapter" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
                    }
                */
                telemetry.telemetry.addCustomGlobalProperty({ 'Versions.DebugAdapter': debugAdapterVersion });


            }).listen(0);
        }

        // make VS Code connect to debug server
        return new vscode.DebugAdapterServer( (<net.AddressInfo>this.server.address()).port);
    }

    dispose() {
        if (this.server) {
            this.server.close();
        }
    }
}
