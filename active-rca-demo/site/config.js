// Must match firmware/src/config.h and bridge/config.json (tools/set_site.py rewrites all three).
// Any value can be overridden in the URL, e.g. ?site=abc123&device=MOTOR-01
window.ARCA = {
  site: "add1f2",
  device: "MOTOR-01",
  broker: "wss://broker.hivemq.com:8884/mqtt",
};
