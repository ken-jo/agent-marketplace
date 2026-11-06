import { readFileSync, writeFileSync } from 'node:fs';
for (const name of ['meeting-control', 'recorder-card']) {
  const script = readFileSync(`dist/ui/${name}.js`, 'utf8').replaceAll('</script', '<\\/script');
  writeFileSync(`dist/ui/${name}.html`, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meeting</title><style>html,body,#app{margin:0;width:100%;height:100%;}body{background:var(--color-background-primary,#fff);color:var(--color-text-primary,#111);}</style></head><body><main id="app"></main><script type="module">${script}</script></body></html>`);
}
