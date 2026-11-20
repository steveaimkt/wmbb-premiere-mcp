import { readJsonOr, writeJsonAtomic } from './fsutil.js';

/** Game term dictionary: { "AKS.7": ["에이케이에스 세븐", ...] }. */
export class Glossary {
  private constructor(private readonly file: string, private entries: Record<string, string[]>) {}

  static async load(file: string): Promise<Glossary> {
    return new Glossary(file, await readJsonOr<Record<string, string[]>>(file, {}));
  }

  /** Replace heard forms with their term, longest heard form first. */
  apply(text: string): string {
    const pairs: [string, string][] = [];
    for (const [term, heard] of Object.entries(this.entries)) {
      for (const h of heard) if (h) pairs.push([h, term]);
    }
    pairs.sort((a, b) => b[0].length - a[0].length);
    let out = text;
    for (const [h, term] of pairs) out = out.split(h).join(term);
    return out;
  }

  promptTerms(): string[] {
    return Object.keys(this.entries).sort();
  }

  asPromptBlock(): string {
    const terms = this.promptTerms();
    if (terms.length === 0) return '(용어 사전 비어 있음)';
    return terms.map((t) => {
      const heard = this.entries[t] ?? [];
      return heard.length ? `- ${t} (들리는 말: ${heard.join(', ')})` : `- ${t}`;
    }).join('\n');
  }

  async add(term: string, heard: string): Promise<void> {
    const list = this.entries[term] ?? [];
    if (heard && heard !== term && !list.includes(heard)) list.push(heard);
    this.entries[term] = list;
    await writeJsonAtomic(this.file, this.entries);
  }
}
