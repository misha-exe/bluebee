#!/usr/bin/env node
// Usage:  npm run hash-password            (prompts, typing is hidden)
//         node scripts/hash-password.js "your password"
// Prints the AUTH_PASSWORD_HASH to paste into your environment variables, plus a fresh AUTH_SECRET.
const crypto = require('crypto');
const { hashPassword } = require('../services/auth');

function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    if (!process.stdin.isTTY) {
      let data = '';
      process.stdin.on('data', (c) => (data += c));
      process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
      return;
    }
    let input = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(input);
        }
        if (c === '\u0003') process.exit(130);                         // Ctrl+C
        if (c === '\u007f' || c === '\b') input = input.slice(0, -1);  // backspace
        else input += c;
      }
    });
  });
}

(async () => {
  const password = process.argv[2] || (await promptHidden('New password: '));
  if (!password || password.length < 8) {
    console.error('Please use a password of at least 8 characters.');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  console.log('\nAdd these to your environment variables (Vercel: Settings -> Environment Variables):\n');
  console.log(`AUTH_PASSWORD_HASH=${hash}`);
  console.log(`AUTH_SECRET=${crypto.randomBytes(32).toString('hex')}   # only generate once; changing it signs everyone out`);
  console.log('AUTH_EMAIL=you@example.com\n');
})();
