import { createDb } from "./db/db";
import { createApp } from "./app";
import { seedParentAndChild } from "./db/seed";

const PORT = process.env.PORT || 3000;
const db = createDb(process.env.DB_PATH || "rewardbank.db");

// Seed a demo parent/child on first boot so you have tokens to test with immediately.
const parentCount = (db.prepare("SELECT COUNT(*) as c FROM parents").get() as { c: number }).c;
if (parentCount === 0) {
  const seed = seedParentAndChild(db, "Demo Parent", "Demo Child");
  console.log("Seeded demo identities:");
  console.log(`  Parent token: ${seed.parentToken}`);
  console.log(`  Child token:  ${seed.childToken}`);
  console.log(`  Child id:     ${seed.childId}`);
}

const app = createApp(db);
app.listen(PORT, () => console.log(`RewardBank listening on :${PORT}`));
