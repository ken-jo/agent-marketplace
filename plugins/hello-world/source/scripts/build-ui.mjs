import { readFileSync, writeFileSync } from 'node:fs';
const script = readFileSync('dist/ui/hello-control.js', 'utf8').replaceAll('</script', '<\\/script');
writeFileSync('dist/ui/hello-control.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hello World</title></head><body><main id="app"></main><script type="module">${script}</script></body></html>`);
