import { createHandlers } from '../src/dashboard/handlers.js';
const h = createHandlers();
export default (req, res) => h.action(req, res);
