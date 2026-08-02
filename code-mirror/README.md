A [CodeMirror 6](https://codemirror.net/) editing package for LambAda.

# [→ Try it in your browser](https://lambada-llc.github.io/lambada/)

The demo page displays an editor alongside the code that produces it. This lets
you compare stock CodeMirror to the package's features (exported by [`src/index.ts`](./src/index.ts)), one feature at a time.

## Running it yourself

``` bash
npm install
npm run dev     # the demo, served
npm run build   # the same page, written to demo-dist/
```

Vite wants Node 20.19+, hence the [`.nvmrc`](./.nvmrc).