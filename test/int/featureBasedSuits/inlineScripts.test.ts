
import * as path from 'path';
import * as testSetup from '../testSetup';
import { setBreakpoint, setConditionalBreakpoint } from '../intTestSupport';
import { puppeteerSuite, puppeteerTest } from '../puppeteer/puppeteerSuite';
import { TestProjectSpec } from '../framework/frameworkTestSupport';
import { FrameworkTestSuite } from '../framework/frameworkCommonTests';

const DATA_ROOT = testSetup.DATA_ROOT;
const INLINE_SCRIPTS_PROJECT_ROOT = path.join(DATA_ROOT, 'inline_scripts');
const TEST_SPEC = new TestProjectSpec( { projectRoot: INLINE_SCRIPTS_PROJECT_ROOT } );

puppeteerSuite('React Framework Tests', TEST_SPEC, (suiteContext) => {

    suite('Common Framework Tests', () => {
        const frameworkTests = new FrameworkTestSuite('Simple JS', suiteContext);

        frameworkTests.genericBreakpointTest("actionButton", 'inlineScript1', page => page.click('#actionButton') );

    });
});