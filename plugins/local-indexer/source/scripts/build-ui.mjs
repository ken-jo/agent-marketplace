import { readFileSync, writeFileSync } from 'node:fs';
const script = readFileSync('dist/ui/indexer-control.js', 'utf8').replaceAll('</script', '<\\/script');
const html = readFileSync('src/ui/indexer-control.html', 'utf8');
writeFileSync('dist/ui/indexer-control.html', html.replace('<script type="module" src="./indexer-control.js"></script>', () => `<script type="module">${script}</script>`));
