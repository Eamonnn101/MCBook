# Skill: Early Game Bootstrap

## Trigger
Empty inventory, no tools at all.

## Goal
Go from nothing to a basic shelter in 2-3 cycles. Do NOT spend more than 1 cycle on tools.

## Steps (Cycle 1: Get wood + basic tool)
1. Find and chop 3 oak_log (or any *_log) — this gives 10+ logs from the trees
2. Craft oak_planks ×3 (each log → 4 planks = 12 total)
3. Craft stick ×1 (2 planks → 4 sticks)
4. Craft crafting_table ×1 (4 planks)
5. Craft wooden_pickaxe ×1 (3 planks + 2 sticks)

## Steps (Cycle 2: BUILD SHELTER with remaining logs)
6. Craft oak_planks with remaining logs
7. Use `place` to build a 5x5 shelter (see 08-building skill)
8. If not enough planks, dig dirt and use dirt blocks

## DO NOT do this:
- Do NOT keep chopping trees after you have 10+ logs
- Do NOT try to upgrade to stone tools before building a shelter
- Do NOT wander around looking for "better" resources

## Example Plan
```json
{
  "reflection": "I have nothing. Need to bootstrap tools from scratch.",
  "plan": [
    { "tool": "mine", "args": { "block_type": "oak_log" }, "note": "chop tree for wood" },
    { "tool": "mine", "args": { "block_type": "oak_log" }, "note": "need more logs" },
    { "tool": "mine", "args": { "block_type": "oak_log" }, "note": "third log" },
    { "tool": "craft", "args": { "item_name": "oak_planks", "count": 3 }, "note": "logs to planks" },
    { "tool": "craft", "args": { "item_name": "stick", "count": 1 }, "note": "planks to sticks" },
    { "tool": "craft", "args": { "item_name": "crafting_table", "count": 1 }, "note": "need for 3x3 recipes" },
    { "tool": "craft", "args": { "item_name": "wooden_pickaxe", "count": 1 }, "note": "first pickaxe" },
    { "tool": "mine", "args": { "block_type": "stone" }, "note": "get cobblestone for upgrades" }
  ]
}
```

## Tips
- Any log type works (oak, birch, spruce, jungle, acacia)
- If no trees visible in scan, move_to a nearby area first
- crafting_table is auto-placed when crafted — no need for a "place" command
- After this sequence you should have: wooden_pickaxe + cobblestone + leftover planks
