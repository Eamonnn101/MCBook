# Skill: Food Hunting

## Trigger
Hunger < 14, or no food items in inventory.

## Food Sources (by effort)

### Easy (no combat)
- `mine` sweet_berry_bush → sweet_berries (restores 2 hunger)
- Apples sometimes drop when mining oak_log

### Medium (requires combat)
- Kill `cow` → raw_beef (restores 3 hunger, 6 if cooked)
- Kill `pig` → raw_porkchop (restores 3, 8 cooked)
- Kill `sheep` → raw_mutton (restores 2, 6 cooked)
- Kill `chicken` → raw_chicken (restores 2, but 30% food poisoning risk!)

### Priority
1. If animals visible in scan → hunt them (best food value)
2. If sweet_berry_bush visible → mine it (safe, no combat)
3. If nothing available → move_to explore and look for animals

## Example Plan (hunt for food)
```json
{
  "reflection": "Getting hungry with no food. Cows visible nearby, will hunt.",
  "plan": [
    { "tool": "equip", "args": { "item_name": "stone_sword" }, "note": "weapon for hunting" },
    { "tool": "attack", "args": { "target_name": "cow" }, "note": "hunt for beef" },
    { "tool": "attack", "args": { "target_name": "cow" }, "note": "hunt second cow" },
    { "tool": "eat", "args": {}, "note": "eat what we got" }
  ]
}
```

## Tips
- Raw meat works fine — no furnace/smelt available, so eat it raw
- Avoid raw_chicken if possible (food poisoning)
- auto-eat local rule triggers at hunger < 8, but proactively hunt before that
- Killing animals with a sword is faster — equip weapon first
