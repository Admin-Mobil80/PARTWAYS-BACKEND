// Clears the local data file. Accounts, workspaces and each organisation's
// demonstration copy are created again on first use.
import fs from 'node:fs';

const file = process.env.DATA_FILE || new URL('../data/store.json', import.meta.url).pathname;
if (process.env.TABLE_NAME) {
  console.log('This script only resets local data. In AWS, each organisation resets its own demonstration workspace from Settings.');
} else {
  fs.rmSync(file, { force: true });
  console.log('Local data cleared. Sign up at http://localhost:8787/hr/#/signup to create a workspace.');
}
