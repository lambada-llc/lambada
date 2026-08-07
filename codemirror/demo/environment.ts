// The DAG modules the page can put in scope, one per file under `env-dags`.
//
// Found rather than listed, so a file dropped in there gets a box of its own
// and nothing else has to be told about it.

const sources = import.meta.glob('./env-dags/*.dag', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface Module {
  /** The file's name without its extension. What the box is labelled. */
  name: string;
  /** The identifier the snippet imports it as. */
  binding: string;
  /** Where it is imported from, relative to the demo. */
  path: string;
  dag: string;
}

/**
 * By name, which is also the order several of them are concatenated in. Each
 * module stands on its own, so the order only decides which definition of a
 * name two of them share wins — the last one.
 */
export const modules: readonly Module[] = Object.entries(sources)
  .map(([path, dag]): Module => {
    const name = path.replace(/^.*\/|\.dag$/g, '');
    return {
      name,
      binding: name.replace(/-(.)/g, (_, letter: string) => letter.toUpperCase()),
      path,
      dag: dag.trim(),
    };
  })
  .sort((a, b) => (a.name < b.name ? -1 : 1));
