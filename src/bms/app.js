// BMS request handling, for Lambda and the local server. Only /api/bms/* routes
// exist here; the website's routes are in a separate router (lib/app.js).
import { bms, authenticate } from './routes.js';

export const handle = (req) => bms.dispatch(req, { authenticate });
