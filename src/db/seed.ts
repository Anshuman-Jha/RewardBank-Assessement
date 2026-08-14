import Database from "better-sqlite3";
import { newId } from "../utils/id";

export interface SeedResult {
  parentId: string;
  parentToken: string;
  childId: string;
  childToken: string;
}

/** Creates one parent and one child with known tokens, for tests/simulator/dev bootstrap. */
export function seedParentAndChild(db: Database.Database, parentName = "Parent", childName = "Child"): SeedResult {
  const parentId = newId("parent");
  const parentToken = newId("ptoken");
  const childId = newId("child");
  const childToken = newId("ctoken");

  db.prepare("INSERT INTO parents (id, name, token) VALUES (?, ?, ?)").run(parentId, parentName, parentToken);
  db.prepare("INSERT INTO children (id, parent_id, name, token, balance_cache) VALUES (?, ?, ?, ?, 0)").run(
    childId,
    parentId,
    childName,
    childToken
  );

  return { parentId, parentToken, childId, childToken };
}
