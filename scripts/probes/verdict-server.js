// Records POST bodies, one per line, into the file named by argv[2].
// The verdict channel for simulator probes: console.log does not reach
// os_log in a Release build, and the library's own sink is the thing
// under test — reporting through it would make "it broke" and "the probe
// never ran" the same silence.
const http = require('http');
const fs = require('fs');

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: node verdict-server.js <outfile>\n');
  process.exit(2);
}

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      fs.appendFileSync(out, body + '\n');
      res.writeHead(200);
      res.end('ok');
    });
  })
  .listen(8099, () => process.stdout.write('verdict server on :8099\n'));
