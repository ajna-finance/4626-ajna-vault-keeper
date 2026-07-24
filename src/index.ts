import 'dotenv/config';
import { setUpCrashHandlers } from './utils/logger.ts';
import { logStartupWarnings } from './utils/startupWarnings.ts';
import { initClient } from './utils/client.ts';
import { runStartupChecks } from './utils/startupChecks.ts';
import { startScheduler } from './utils/scheduler.ts';

setUpCrashHandlers();
logStartupWarnings();
await initClient();
await runStartupChecks();
startScheduler();
