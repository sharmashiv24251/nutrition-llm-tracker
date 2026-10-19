// Guards the "never touch the old app's objects" rule.
// Run: bun scripts/check-migrations.ts   (exit 1 on any violation)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const INVENTORY = join(ROOT, "docs/existing-objects.md");

export function existingNames(markdown: string): Set<string> {
  const block = markdown.match(/```names\n([\s\S]*?)```/);
  if (!block) throw new Error("No ```names block in docs/existing-objects.md");
  return new Set(block[1].split(/\s+/).filter(Boolean));
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''"); // string literals can't name objects
}

// Names of objects a statement creates or modifies.
const CREATE_RE =
  /\bcreate\s+(?:or\s+replace\s+)?(?:unique\s+)?(table|type|index|function|view|materialized\s+view|trigger|sequence|policy|schema|extension)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?("?[\w]+"?)/gi;
const DESTRUCTIVE_RE =
  /\b(drop|alter|truncate)\s+(?:table|type|index|function|view|materialized\s+view|trigger|sequence|policy|schema|extension)?\s*(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?("?[\w]+"?)/gi;
// `alter table` / `drop trigger x on <table>` / writes into tables
const TARGET_RE =
  /\b(?:on|into|update|from|references|truncate)\s+(?:only\s+)?(?:table\s+)?(?:public\.)?("?[\w]+"?)/gi;

export function checkSql(file: string, sql: string, existing: Set<string>): string[] {
  const errors: string[] = [];
  const clean = stripComments(sql).toLowerCase();
  const bare = (n: string) => n.replace(/"/g, "");

  for (const m of clean.matchAll(CREATE_RE)) {
    const name = bare(m[2]);
    if (!name.startsWith("trk_")) errors.push(`${file}: creates ${m[1]} "${name}" without trk_ prefix`);
  }
  // Only the leading keyword of a statement counts, so `alter column` / `drop not null` don't.
  for (const stmt of clean.split(";")) {
    const m = stmt.trim().match(new RegExp("^" + DESTRUCTIVE_RE.source, "i"));
    if (m) {
      const name = bare(m[2]);
      if (!name.startsWith("trk_")) errors.push(`${file}: ${m[1]} on non-trk_ object "${name}"`);
    }
  }
  for (const m of clean.matchAll(TARGET_RE)) {
    const name = bare(m[1]);
    if (existing.has(name)) errors.push(`${file}: references existing object "${name}"`);
  }
  // Any bare identifier equal to an existing object name is suspicious.
  for (const token of new Set(clean.match(/\b[a-z_][a-z0-9_]*\b/g) ?? [])) {
    if (existing.has(token)) errors.push(`${file}: mentions existing object "${token}"`);
  }
  return [...new Set(errors)];
}

export function checkAll(): string[] {
  const existing = existingNames(readFileSync(INVENTORY, "utf8"));
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => checkSql(f, readFileSync(join(MIGRATIONS_DIR, f), "utf8"), existing));
}

if (import.meta.main) {
  const errors = checkAll();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("migrations OK: only trk_ objects created or modified");
}
