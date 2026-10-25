"""Rebuild the curated launch bundle from pinned public source downloads.

Downloads are explicit, outside this script. No network, AWS or image handling.
"""

import argparse
import csv
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from form_backend.catalog import exercise_from_source, food_from_source, normalized, validate_bundle
from form_backend.core import json_text

EXERCISE_COMMIT = "f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5"
USDA_MIRROR_COMMIT = "ebd94b90f03476b93549af056524e9138a7c8e3e"
EXPECTED_INPUT_SHA256 = {
    "exercises.json": "5bb747e3fc658f095a60dcbf6d53c96627acdcc6ffb6fffde86f7e26995d40bf",
    "fndds_ingredient_nutrient_value.csv": "769d5c0a0c68cd05041247c82c2d50812ba837deb22ef99f219a8c95f4c17fd2",
    "nutrient.csv": "226ba937d1a73e8c87bd7fdcdd577524699bef4025c9232ee474b7d3083498ff",
}
ROOT = Path(__file__).resolve().parents[1] / "catalog" / "launch-v1"


def preparation(name):
    text = name.lower()
    # Commercially processed foods retain their full descriptor, e.g. frozen/unprepared.
    if re.search(r"canned|frozen|ready-to-eat|ready to eat|babyfood|commercially|bottled", text):
        return "packaged", "explicit commercial/frozen/canned descriptor"
    if re.search(
        r"\b(cooked|boiled|baked|roasted|fried|grilled|steamed|toasted|scrambled|poached)\b", text
    ):
        return "cooked", "explicit cooking descriptor"
    if re.search(r"\braw\b", text):
        if "mature seeds" in text or text.startswith(
            (
                "rice,",
                "wild rice,",
                "wheat,",
                "oats,",
                "oat bran,",
                "barley,",
                "quinoa,",
                "lentils,",
            )
        ):
            return "dry", "raw mature seed/grain, not hydrated cooked weight"
        return "raw", "explicit raw descriptor"
    if re.search(r"\bdry\b|dried|dehydrated|uncooked|flour|cornmeal", text):
        return "dry", "explicit dry/uncooked/flour descriptor"
    if text.startswith("spices,"):
        return "dry", "curated dry spice classification"
    if text.startswith(
        (
            "cheese,",
            "yogurt,",
            "milk,",
            "butter,",
            "oil,",
            "bread,",
            "tofu,",
            "soymilk,",
            "soy milk,",
            "cereals ready-to-eat,",
        )
    ):
        return "packaged", "curated processed dairy/oil/bread/soy product classification"
    return None, None


def food_group(name):
    n = name.lower()
    if any(
        w in n
        for w in (
            "beans,",
            "lentils,",
            "chickpeas",
            "tofu,",
            "soybeans",
            "tempeh",
            "peas, split",
            "peanuts,",
        )
    ):
        return "legumes"
    if n.startswith(("nuts,", "seeds,")):
        return "nuts-seeds"
    if n.startswith(("cheese,", "milk,", "yogurt,", "egg,", "egg white", "soymilk,", "soy milk,")):
        return "dairy-eggs-alternatives"
    if n.startswith(("oil,", "spices,", "butter,")):
        return "oils-spices"
    if re.search(
        r"\b(beef|pork|lamb|chicken|turkey|fish|crustaceans|mollusks|meat|goat|duck|goose|ham|bacon|sausage|lard|salmon|tuna|shrimp|anchovy|gelatin)\b",
        n,
    ):
        return "meat-fish"
    if re.search(
        r"rice|oat|wheat|quinoa|barley|buckwheat|pasta|spaghetti|macaroni|bread,|cornmeal|cereals",
        n,
    ):
        return "grains"
    if re.search(
        r"apple|banana|berries|berry|orange|mango|papaya|grape|peach|pear|plum|pineapple|melon|kiwi|lemon|lime|apricot|cherr|date|fig|raisin|avocado",
        n,
    ):
        return "fruit"
    if re.search(
        r"broccoli|spinach|potato|tomato|onion|carrot|cabbage|cauliflower|pepper|mushroom|lettuce|cucumber|squash|eggplant|beet|asparagus|celery|kale|greens|turnip|radish|okra|leek|garlic|peas, green|corn,|artichoke|brussels",
        n,
    ):
        return "vegetables"
    return None


def food_aliases(name):
    result = []
    for token, aliases in {
        "chickpeas": ["chickpea", "garbanzo", "chana"],
        "lentils": ["lentil", "dal"],
        "eggplant": ["aubergine", "brinjal"],
        "zucchini": ["courgette"],
        "cilantro": ["coriander leaves"],
        "arugula": ["rocket"],
        "yogurt": ["yoghurt"],
        "beans, kidney": ["kidney beans", "rajma"],
        "okra": ["bhindi"],
        "chard": ["swiss chard"],
        "oats": ["oatmeal"],
        "garbanzo": ["chickpea", "chana"],
    }.items():
        if token in name.lower():
            result.extend(aliases)
    return result


def write_json(path, value):
    path.write_text(json_text(value) + "\n")


def build(source_dir, output=ROOT):
    for name, expected in EXPECTED_INPUT_SHA256.items():
        if hashlib.sha256((source_dir / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f"Pinned source checksum mismatch: {name}")
    output.mkdir(parents=True, exist_ok=True)
    (output / "sources").mkdir(exist_ok=True)
    ex_raw = json.loads((source_dir / "exercises.json").read_text())
    ex_groups = defaultdict(list)
    excluded = Counter()
    for raw in ex_raw:
        try:
            value = exercise_from_source(raw)
        except (ValueError, KeyError) as exc:
            excluded["exercise:" + type(exc).__name__] += 1
            continue
        # Prefer common equipment, compound moves and beginner/intermediate variants.
        score = (
            value.equipment == "Other",
            raw["level"] == "expert",
            raw.get("mechanic") != "compound",
            len(value.name),
            value.name.casefold(),
        )
        ex_groups[value.primary_muscle].append((score, raw, value))
    for values in ex_groups.values():
        values.sort(key=lambda v: v[0])
    selected_ex, ex_seen = [], set()
    while len(selected_ex) < 400:
        progress = False
        for group in sorted(ex_groups):
            if group == "Other" and sum(v.primary_muscle == "Other" for _, v in selected_ex) >= 12:
                continue
            if not ex_groups[group] or len(selected_ex) == 400:
                continue
            _, raw, value = ex_groups[group].pop(0)
            key = normalized(value.name)
            if key in ex_seen:
                excluded["exercise:duplicate_name"] += 1
                continue
            ex_seen.add(key)
            selected_ex.append((raw, value))
            progress = True
        if not progress:
            raise ValueError("Not enough distinct strength exercises")
    units = {
        r["nutrient_nbr"]: r["unit_name"]
        for r in csv.DictReader((source_dir / "nutrient.csv").open())
    }
    # Multiple recipe-ingredient appearances must agree for the same FDC nutrient.
    foods = {}
    contradictions = set()
    for row in csv.DictReader((source_dir / "fndds_ingredient_nutrient_value.csv").open()):
        number = row["Nutrient code"]
        if row["Nutrient value source"] != "SR Legacy" or number not in (
            "203",
            "204",
            "205",
            "208",
        ):
            continue
        id = row["FDC ID"]
        raw = foods.setdefault(
            id,
            {
                "fdcId": id,
                "description": row["Ingredient description"],
                "dataType": "SR Legacy",
                "nutrients": {},
            },
        )
        nutrient = {"number": number, "amount": row["Nutrient value"], "unit": units[number]}
        if number in raw["nutrients"] and raw["nutrients"][number] != nutrient:
            contradictions.add(id)
        raw["nutrients"][number] = nutrient
    groups = defaultdict(list)
    for id, raw in foods.items():
        if id in contradictions:
            excluded["food:contradictory_source"] += 1
            continue
        raw["nutrients"] = sorted(raw["nutrients"].values(), key=lambda n: n["number"])
        state, reason = preparation(raw["description"])
        group = food_group(raw["description"])
        if not state or not group:
            excluded["food:outside_curated_scope_or_ambiguous_state"] += 1
            continue
        try:
            value = food_from_source(raw, state, food_aliases(raw["description"]))
        except ValueError:
            excluded["food:invalid_nutrients_or_name"] += 1
            continue
        priority = value.external_id in {
            "168877",
            "168878",
            "169703",
            "169704",
            "172430",
            "170158",
            "173944",
            "170379",
            "168462",
            "171287",
            "173424",
            "172420",
            "172421",
            "173756",
            "173757",
            "172449",
            "170903",
            "171304",
        }
        score = (
            not priority,
            "babyfood" in value.name.lower(),
            "with salt" in value.name.lower(),
            len(value.name),
            value.name.casefold(),
            id,
        )
        groups[group].append((score, raw, value, reason))
    quotas = {
        "vegetables": 90,
        "fruit": 55,
        "legumes": 55,
        "grains": 72,
        "nuts-seeds": 17,
        "dairy-eggs-alternatives": 61,
        "oils-spices": 25,
        "meat-fish": 25,
    }
    selected_food, food_seen = [], set()
    for group, target in quotas.items():
        choices = sorted(groups[group], key=lambda x: x[0])
        for _, raw, value, reason in choices:
            key = normalized(value.name), value.preparation
            if key in food_seen:
                excluded["food:duplicate_name_state"] += 1
                continue
            if target == 0:
                break
            selected_food.append((raw, value, group, reason))
            food_seen.add(key)
            target -= 1
        if target:
            raise ValueError(
                f"Need {target} more eligible foods in {group}; available {len(choices)}"
            )
    items = [{"kind": "exercise", "value": v.model_dump()} for _, v in selected_ex]
    items += [{"kind": "food", "value": v.model_dump()} for _, v, _, _ in selected_food]
    bundle = {"version": 1, "items": sorted(items, key=lambda i: (i["kind"], i["value"]["id"]))}
    validate_bundle(bundle)
    write_json(output / "catalog.json", bundle)
    # Only selected text and nutrient records are redistributed. No media files or image URLs.
    write_json(
        output / "sources/exercises.json",
        [{k: v for k, v in raw.items() if k != "images"} for raw, _ in selected_ex],
    )
    write_json(output / "sources/foods.json", [raw for raw, _, _, _ in selected_food])
    write_json(
        output / "selection.json",
        {
            "exercises": [v.external_id for _, v in selected_ex],
            "foods": [
                {"fdcId": v.external_id, "preparation": v.preparation, "group": g, "reason": reason}
                for _, v, g, reason in selected_food
            ],
        },
    )
    manifest = {
        "exerciseCommit": EXERCISE_COMMIT,
        "usdaMirrorCommit": USDA_MIRROR_COMMIT,
        "usdaRelease": "FoodData Central CSV 2025-04-24, ingredient values sourced from SR Legacy",
        "officialUsdaDownload": "https://fdc.nal.usda.gov/download-datasets.html",
        "usdaMirror": f"https://github.com/antiffraud/dataset-nutrisi-makanan/tree/{USDA_MIRROR_COMMIT}/FoodData_Central_csv_2025-04-24",
        "licenses": {
            "exercise": "Unlicense (text only; media excluded)",
            "food": "USDA public domain / CC0",
        },
        "inputSha256": {
            name: hashlib.sha256((source_dir / name).read_bytes()).hexdigest()
            for name in ("exercises.json", "nutrient.csv", "fndds_ingredient_nutrient_value.csv")
        },
        "bundleSha256": hashlib.sha256((output / "catalog.json").read_bytes()).hexdigest(),
        "note": "USDA CSV retrieved from a pinned third-party mirror; official USDA host was blocked in the build environment. No independent official archive checksum verification claimed.",
    }
    write_json(output / "manifest.json", manifest)
    report = {
        "exercises": len(selected_ex),
        "foods": len(selected_food),
        "exerciseMuscles": Counter(v.primary_muscle for _, v in selected_ex),
        "exerciseEquipment": Counter(v.equipment for _, v in selected_ex),
        "unilateralExercises": sum(v.unilateral for _, v in selected_ex),
        "foodGroups": Counter(g for _, _, g, _ in selected_food),
        "foodStates": Counter(v.preparation for _, v, _, _ in selected_food),
        "excluded": excluded,
        "missingRequiredNutrientsImported": 0,
        "imagesImported": 0,
    }
    write_json(output / "quality-report.json", report)
    (output / "sources/EXERCISE-LICENSE.md").write_bytes(
        (source_dir / "exercise-LICENSE.md").read_bytes()
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    args = parser.parse_args()
    build(args.source_dir)
