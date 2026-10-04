'use strict';
// A separate offline server lets the recovery regression terminate the process without calling stop().
if (process.send) {
  const path = require('path');
  const { createServer } = require('../server/server');
  const srv = createServer({
    dataDir: process.argv[2],
    publicDir: path.join(__dirname, '..', 'public'),
    appVersion: 'test',
    testHooks: {
      offline: true,
      captureTip: async () => {
        process.send({ type: 'capture' });
        return 'ok';
      }
    }
  });
  process.on('message', message => {
    if (message.type === 'inject') srv.testHooks.injectTip(message.tip);
  });
  srv
    .start()
    .then(() => {
      process.send({ type: 'ready' });
      const timer = setInterval(() => {
        if (srv.state().overlays) {
          process.send({ type: 'overlay' });
          clearInterval(timer);
        }
      }, 10);
    })
    .catch(error => {
      process.send({ type: 'error', message: error.message });
      process.exit(1);
    });
}
