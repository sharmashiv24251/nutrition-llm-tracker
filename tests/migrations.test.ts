import { describe, expect, test } from "bun:test";
import { checkAll, checkSql } from "../scripts/check-migrations";

const existing = new Set(["exercises", "plans", "set_logs", "visibility"]);

describe("migration guard", () => {
  test("repo migrations only touch trk_ objects", () => {
    expect(checkAll()).toEqual([]);
  });

  test("flags non-prefixed creates", () => {
    expect(checkSql("x", "create table foo (id int);", existing)).toHaveLength(1);
  });

  test("flags destructive statements on old tables", () => {
    for (const sql of [
      "drop table exercises;",
      "alter table public.plans add column x int;",
      "truncate set_logs;",
      "insert into exercises values (1);",
    ]) {
      expect(checkSql("x", sql, existing).length).toBeGreaterThan(0);
    }
  });

  test("allows trk_ objects and ignores comments", () => {
    const sql = `-- the old exercises table is not ours
      create table trk_exercises (id uuid);
      alter table trk_exercises enable row level security;`;
    expect(checkSql("x", sql, existing)).toEqual([]);
  });
});

test("column-level alters on trk_ tables pass; on old tables fail", () => {
  const existing = new Set(["plans"]);
  expect(checkSql("x", "alter table trk_targets alter column fat_g drop not null;", existing)).toEqual([]);
  expect(checkSql("x", "alter table plans alter column name drop not null;", existing).length).toBeGreaterThan(0);
});
