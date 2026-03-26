# Skill: Night Survival

## Trigger
isDay = false (nighttime)

## Decision Tree
```
Night?
├─ Have sword?
│  ├─ HP > 10 → Fight mobs (XP + drops)
│  └─ HP ≤ 10 → Eat if possible, then fight or dig hole
└─ No sword?
   └─ Dig hole: mine dirt ×3 to go underground
```

## Option A: Fight (have weapon, good HP)
```json
{
  "reflection": "Night time, I'm armed and healthy. Will hunt mobs for XP.",
  "plan": [
    { "tool": "equip", "args": { "item_name": "stone_sword" }, "note": "ready for combat" },
    { "tool": "attack", "args": { "target_name": "zombie" }, "note": "hunt for XP" },
    { "tool": "attack", "args": { "target_name": "skeleton" }, "note": "more XP" },
    { "tool": "eat", "args": {}, "note": "heal between fights" }
  ]
}
```

## Option B: Dig hole (no weapon or low HP)
```json
{
  "reflection": "Night with no weapon. Digging a hole to hide until dawn.",
  "plan": [
    { "tool": "mine", "args": { "block_type": "dirt" }, "note": "dig down" },
    { "tool": "mine", "args": { "block_type": "dirt" }, "note": "deeper" },
    { "tool": "mine", "args": { "block_type": "dirt" }, "note": "safe depth" }
  ]
}
```

## Tips
- Night lasts ~7 minutes real time
- Mobs spawn on the surface at night — underground is safer
- If you see a creeper at night, flee immediately (move_to away)
- Dawn = isDay becomes true again. Resume normal activities.
- There is no "sleep" or "bed" command — only wait or fight
