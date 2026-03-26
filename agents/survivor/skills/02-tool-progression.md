# Skill: Tool Progression

## Trigger
Have wooden tools but no stone tools yet, or missing key tools (sword, axe).

## Tool Tier Chart
| Tool | Materials | Prerequisite |
|------|-----------|-------------|
| wooden_pickaxe | 3 planks + 2 sticks | crafting_table |
| wooden_sword | 2 planks + 1 stick | crafting_table |
| wooden_axe | 3 planks + 2 sticks | crafting_table |
| wooden_shovel | 1 plank + 2 sticks | crafting_table |
| stone_pickaxe | 3 cobblestone + 2 sticks | crafting_table + wooden_pickaxe |
| stone_sword | 2 cobblestone + 1 stick | crafting_table |
| stone_axe | 3 cobblestone + 2 sticks | crafting_table |
| stone_shovel | 1 cobblestone + 2 sticks | crafting_table |

## Upgrade Path
1. Ensure you have sticks (craft from planks if needed)
2. Mine stone ×6+ to get cobblestone
3. Craft stone_pickaxe first (most important)
4. Craft stone_sword second (for combat)
5. Craft stone_axe if you need to chop trees faster

## Example Plan (wood → stone upgrade)
```json
{
  "reflection": "I have wooden tools. Time to upgrade to stone tier.",
  "plan": [
    { "tool": "equip", "args": { "item_name": "wooden_pickaxe" }, "note": "need pickaxe to mine stone" },
    { "tool": "mine", "args": { "block_type": "stone" }, "note": "get cobblestone" },
    { "tool": "mine", "args": { "block_type": "stone" }, "note": "more cobblestone" },
    { "tool": "mine", "args": { "block_type": "stone" }, "note": "enough for tools" },
    { "tool": "craft", "args": { "item_name": "stone_pickaxe", "count": 1 }, "note": "upgrade pickaxe" },
    { "tool": "craft", "args": { "item_name": "stone_sword", "count": 1 }, "note": "better weapon" }
  ]
}
```

## Tips
- Iron tools require smelting (no smelt tool available) — stone is max tier
- Always keep spare sticks and cobblestone for replacements
- stone_pickaxe can mine iron_ore and coal_ore
