/** Native Scratch / TurboWarp project editing. Requires Node.js 24. */
export interface ReadOptions { target?: string; script?: string; format?: 'json' | 'text'; }
export interface Diagnostic { code?: string; message?: string; [key: string]: unknown; }
export interface BlockNode {
  id?: string;
  opcode: string;
  fields?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  mutation?: Record<string, unknown>;
  [key: string]: unknown;
}
export type ScriptBody = BlockNode[] | {body: BlockNode[]; position?: {x: number; y: number}};
export interface BlockPatch {
  inputs?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  position?: {x: number; y: number};
}
export interface ProcedureParameter {
  name: string;
  type: 'number' | 'text' | 'boolean';
  default?: string | number | boolean;
}
export interface ProcedureSpec {
  name: string;
  params?: ProcedureParameter[];
  type?: 'statement' | 'reporter' | 'boolean';
  returnType?: 'statement' | 'reporter' | 'boolean';
  warp?: boolean;
}
export type ProcedurePatch = Partial<Omit<ProcedureSpec, 'name'>> & {newName?: string};
export type EditOperation =
  | ({op: 'block.update'; target?: string; id: string} & BlockPatch)
  | {op: 'script.add'; target?: string; body: ScriptBody}
  | {op: 'script.replace'; target?: string; root: string; body: ScriptBody}
  | {op: 'script.delete'; target?: string; root: string}
  | ({op: 'procedure.define'; target?: string} & ProcedureSpec)
  | ({op: 'procedure.update'; target?: string; name: string} & ProcedurePatch)
  | {op: 'procedure.delete'; target?: string; name: string}
  | {op: 'command'; command: string; args: string[]; target?: string};
export interface EditDocument {version: 1; baseRevision?: string; operations: EditOperation[];}
export interface BatchOptions {out?: string; force?: boolean;}
export interface SavedProject {path: string; bytes: number; sha256?: string; [key: string]: unknown;}
export interface EditReport {
  version?: 1;
  changed: boolean;
  revision: string;
  operations: unknown[];
  idMap: Record<string, string>;
  diagnostics: Diagnostic[];
  saved?: SavedProject;
}
export interface ValidationReport {valid: boolean; diagnostics: Diagnostic[]; [key: string]: unknown;}
export interface ScriptView {root: string; body?: BlockNode[]; [key: string]: unknown;}
export interface ResourceView {id: string; name: string; value: unknown; cloud: boolean;}
export interface AssetView {id: string; name: string; assetId: string; md5: string; format: string; [key: string]: unknown;}
export interface TargetView {
  id: string;
  name: string;
  isStage: boolean;
  scripts: ScriptView[];
  variables: ResourceView[];
  lists: ResourceView[];
  broadcasts: ResourceView[];
  assets: {costumes: AssetView[]; sounds: AssetView[]};
  procedures: unknown[];
  [key: string]: unknown;
}
export interface ProjectView {
  version?: number;
  revision: string;
  targets: TargetView[];
  diagnostics: Diagnostic[];
  [key: string]: unknown;
}
export interface SearchMatch {target?: string; id?: string; root?: string; [key: string]: unknown;}
export type SearchResult = SearchMatch[];
export interface AssetEditor {
  add(filename: string): Promise<EditReport>;
  import(filename: string): Promise<EditReport>;
  rename(selector: string | number, name: string): Promise<EditReport>;
  delete(selector: string | number): Promise<EditReport>;
  reorder(selector: string | number, index: number): Promise<EditReport>;
}
export interface TargetEditor {
  readonly id: string;
  read(options?: Omit<ReadOptions, 'target'> & {format?: 'json'}): Promise<ProjectView>;
  read(options: Omit<ReadOptions, 'target'> & {format: 'text'}): Promise<{text: string}>;
  find(query: string): Promise<SearchResult>;
  readonly scripts: {
    add(body: ScriptBody): Promise<EditReport>;
    replace(root: string, body: ScriptBody): Promise<EditReport>;
    delete(root: string): Promise<EditReport>;
    read(root: string): Promise<ProjectView>;
  };
  readonly blocks: {update(id: string, patch: BlockPatch): Promise<EditReport>};
  readonly procedures: {
    define(spec: ProcedureSpec): Promise<EditReport>;
    update(name: string, patch: ProcedurePatch): Promise<EditReport>;
    delete(name: string): Promise<EditReport>;
  };
  readonly variables: {
    add(name: string, value?: unknown, options?: {type?: string}): Promise<EditReport>;
    set(name: string, value: unknown): Promise<EditReport>;
    rename(name: string, newName: string): Promise<EditReport>;
    delete(name: string): Promise<EditReport>;
  };
  readonly lists: {
    add(name: string, values?: unknown[]): Promise<EditReport>;
    set(name: string, values: unknown[]): Promise<EditReport>;
    append(name: string, value: unknown): Promise<EditReport>;
    clear(name: string): Promise<EditReport>;
    rename(name: string, newName: string): Promise<EditReport>;
    delete(name: string): Promise<EditReport>;
  };
  readonly assets: {costumes: AssetEditor; sounds: AssetEditor};
}
export interface EditableProject {
  read(options?: ReadOptions & {format?: 'json'}): Promise<ProjectView>;
  read(options: ReadOptions & {format: 'text'}): Promise<{text: string}>;
  find(query: string, options?: {target?: string; opcode?: string; resource?: string}): Promise<SearchResult>;
  target(selector?: string): TargetEditor;
  batch(document: EditDocument | EditOperation[], options?: BatchOptions): Promise<EditReport>;
  batch(callback: (project: EditableProject) => unknown | Promise<unknown>, options?: BatchOptions): Promise<EditReport>;
  validate(document?: EditDocument | EditOperation[]): Promise<ValidationReport>;
  save(filename: string, options?: {force?: boolean}): Promise<SavedProject>;
  dispose(): void;
}
export function openProject(input: string | Uint8Array): Promise<EditableProject>;
export function createProject(): Promise<EditableProject>;
