// What a reader produces for one source file. Ingest turns sections into
// chunks (splitting long ones), and symbols into rows linked to the chunk
// that documents them.

export interface Section {
  heading: string;
  // Stable id within the page (e.g. an RST label), used to link symbols to
  // the chunk that documents them.
  anchor?: string;
  text: string;
}

export interface DocSymbol {
  // Fully qualified, e.g. `Node2D.global_position`, or a bare class name.
  name: string;
  // Member part only (`global_position`), for lookups without the class.
  member?: string;
  kind: string;
  anchor: string;
}

export interface Page {
  path: string;
  title: string;
  body: string;
  sections: Section[];
  symbols: DocSymbol[];
}

export type Reader = (root: string, relPath: string, content: string) => Page | null;
