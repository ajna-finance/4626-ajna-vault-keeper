import { startScheduler } from './utils/scheduler';
import { run } from './keeper';

startScheduler(run);
