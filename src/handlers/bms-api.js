// BMS API: Lambda entry point behind bms.partways.org. A separate function and
// router from the website API, so neither can reach the other's routes.
import { handle } from '../bms/app.js';
import { lambdaHandler } from '../lib/lambda.js';

export const handler = lambdaHandler(handle);
