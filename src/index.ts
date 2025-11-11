import { setUpCrashHandlers } from './utils/logger';
import { startScheduler } from './utils/scheduler';
import { run } from './keeper';

setUpCrashHandlers();
startScheduler(run);
