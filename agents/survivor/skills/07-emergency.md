# Skill: Emergency Response

## Trigger
HP < 6, just died and respawned, or lost/disoriented.

## Emergency: Low HP (< 6)
**Priority**: Eat → Flee → Hide

```json
{
  "reflection": "CRITICAL: HP very low. Must eat and escape danger immediately.",
  "plan": [
    { "tool": "eat", "args": {}, "note": "emergency heal" },
    { "tool": "move_to", "args": { "x": <safe_x>, "y": <safe_y>, "z": <safe_z> }, "note": "flee from danger" },
    { "tool": "mine", "args": { "block_type": "dirt" }, "note": "dig hole for safety" }
  ]
}
```

## Emergency: Just Died / Respawned
**Priority**: Re-bootstrap tools immediately

After death you lose all items. Follow the early-game bootstrap:
```json
{
  "reflection": "Just respawned after death. Need to rebuild from scratch.",
  "plan": [
    { "tool": "mine", "args": { "block_type": "oak_log" }, "note": "start over - get wood" },
    { "tool": "mine", "args": { "block_type": "oak_log" }, "note": "more wood" },
    { "tool": "mine", "args": { "block_type": "oak_log" }, "note": "enough for tools" },
    { "tool": "craft", "args": { "item_name": "oak_planks", "count": 3 }, "note": "make planks" },
    { "tool": "craft", "args": { "item_name": "stick", "count": 1 }, "note": "make sticks" },
    { "tool": "craft", "args": { "item_name": "crafting_table", "count": 1 }, "note": "need for tools" },
    { "tool": "craft", "args": { "item_name": "wooden_pickaxe", "count": 1 }, "note": "first tool" },
    { "tool": "craft", "args": { "item_name": "wooden_sword", "count": 1 }, "note": "defense" }
  ]
}
```

## Emergency: Creeper Nearby
**Priority**: FLEE IMMEDIATELY
Move 15+ blocks in opposite direction from creeper position.

## Emergency: Multiple Hostiles
If surrounded by 3+ hostile mobs and HP < 10:
- Flee first, fight later
- Dig underground if no escape route

## Tips
- In emergencies, shorter plans (3-4 steps) are better — next think cycle is coming soon
- Flee direction: take your position, subtract mob position, move that direction
- After emergency, next cycle should focus on restabilizing (food, tools, shelter)
