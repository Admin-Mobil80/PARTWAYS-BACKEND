// Website API: Lambda entry point (Function URL with response streaming, behind CloudFront).
import { handle } from '../lib/app.js';
import { lambdaHandler } from '../lib/lambda.js';

export const handler = lambdaHandler(handle);
