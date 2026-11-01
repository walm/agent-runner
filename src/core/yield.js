// three yields to the browser between the objects it compiles (Renderer.compileAsync) and between the stages of
// every shader it builds, with scheduler.yield() where there is one, else by waiting for the next animation frame.
// WebKit (Safari, the desktop app's web view) has no scheduler.yield, and a frame per yield made the boot's
// warm-up take over a minute there instead of ~3 s. A message to ourselves yields as well, without the wait.
if (typeof self !== 'undefined' && !self.scheduler?.yield) {
  const channel = new MessageChannel();
  const waiting = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  const yieldNow = () => new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });
  if (self.scheduler) self.scheduler.yield = yieldNow;
  else self.scheduler = { yield: yieldNow };
}
