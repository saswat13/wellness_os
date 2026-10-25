"""Offline catalog validation/normalization and conditional, catalog-only imports.

No client is constructed on import. No scan, batch overwrite, delete or private keys.
"""

import re
import unicodedata
from collections import Counter
from decimal import Decimal
from pathlib import Path

from .core import digest, json_text, load_json, utcnow
from .models import Equipment, Exercise, Food, Muscle, Nutrients, Pattern

IMPORTER = "form-launch-catalog-v1"
BUNDLE = Path(__file__).resolve().parents[1] / "catalog" / "launch-v1" / "catalog.json"
MUSCLES: dict[str, Muscle] = {
    "abdominals": "Core",
    "abductors": "Glutes",
    "adductors": "Other",
    "biceps": "Biceps",
    "calves": "Calves",
    "chest": "Chest",
    "forearms": "Other",
    "glutes": "Glutes",
    "hamstrings": "Hamstrings",
    "lats": "Lats",
    "lower back": "Other",
    "middle back": "Upper back",
    "neck": "Other",
    "quadriceps": "Quads",
    "shoulders": "Shoulders",
    "traps": "Upper back",
    "triceps": "Triceps",
}
EQUIPMENT: dict[str, Equipment] = {
    "barbell": "Barbell",
    "dumbbell": "Dumbbell",
    "cable": "Cable",
    "machine": "Machine",
    "body only": "Bodyweight",
    "bands": "Band",
    "kettlebells": "Other",
    "medicine ball": "Other",
    "exercise ball": "Other",
    "e-z curl bar": "Barbell",
    "foam roll": "Other",
    "other": "Other",
}


def normalized(value):
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def unique_aliases(name, aliases):
    seen, result = {normalized(name)}, []
    for value in aliases:
        value = " ".join(value.split())
        if value and normalized(value) not in seen:
            seen.add(normalized(value))
            result.append(value)
    return tuple(result[:20])


def exercise_from_source(raw):
    source_id = raw["id"]
    name = " ".join(raw["name"].replace("_", " ").split())
    muscles = [MUSCLES[m] for m in raw["primaryMuscles"]]
    if not muscles or raw["category"] not in ("strength", "powerlifting"):
        raise ValueError("Not a launch strength exercise")
    primary = muscles[0]
    secondary = tuple(
        dict.fromkeys(MUSCLES[m] for m in raw["secondaryMuscles"] if MUSCLES[m] != primary)
    )
    equipment = EQUIPMENT.get(raw.get("equipment"), "Other")
    if "smith" in name.lower():
        equipment = "Smith machine"
    text = name.lower()
    unilateral = bool(re.search(r"single[ -](?:arm|leg)|one[ -](?:arm|leg)|alternat", text))
    pattern: Pattern
    if "lunge" in text or "split squat" in text:
        pattern = "Lunge"
        unilateral = True
    elif "squat" in text or "leg press" in text:
        pattern = "Squat"
    elif any(word in text for word in ("deadlift", "good morning", "hip thrust")):
        pattern = "Hinge"
    elif "row" in text:
        pattern = "Horizontal pull"
    elif any(word in text for word in ("pull-up", "pullup", "chin-up", "pulldown", "pull down")):
        pattern = "Vertical pull"
    elif "press" in text and primary == "Shoulders":
        pattern = "Vertical push"
    elif primary == "Chest" and ("press" in text or "push-up" in text or "pushup" in text):
        pattern = "Horizontal push"
    else:
        pattern = "Isolation" if raw.get("mechanic") == "isolation" else "Other"
    aliases = [source_id.replace("_", " ")]
    for word, alternate in (
        ("pull-up", "pullup chin-up"),
        ("pulldown", "pull down lat pulldown"),
        ("push-up", "pushup press up"),
        ("deadlift", "dead lift"),
        ("dumbbell", "DB"),
        ("barbell", "BB"),
    ):
        if word in text:
            aliases.append(alternate)
    return Exercise(
        id="freeex-" + source_id,
        name=name,
        aliases=unique_aliases(name, aliases),
        external_id=source_id,
        primary_muscle=primary,
        secondary_muscles=secondary,
        equipment=equipment,
        movement_pattern=pattern,
        unilateral=unilateral,
        tags=tuple(dict.fromkeys(("strength", raw["level"], *raw["primaryMuscles"]))),
        training_types=("hypertrophy", "powerlifting")
        if raw["category"] == "powerlifting"
        else ("hypertrophy",),
        coaching_notes="\n".join(raw["instructions"]),
        demo_url="",
        source_info=f"free-exercise-db; {source_id}; Unlicense; https://github.com/yuhonas/free-exercise-db",
    )


def food_from_source(raw, preparation, aliases=()):
    """Input is original USDA ingredient values, per 100 g edible portion.

    Nutrient numbers are USDA's stable nutrient numbers, not array positions.
    Missing values and conflicting duplicates must never become invented zeroes.
    """
    expected = {
        "203": ("protein", "G"),
        "204": ("fat", "G"),
        "205": ("carbs", "G"),
        "208": ("calories", "KCAL"),
    }
    values: dict[str, Decimal] = {}
    for item in raw["nutrients"]:
        number = str(item["number"])
        if number not in expected:
            continue
        key, unit = expected[number]
        if item["unit"].upper() != unit:
            raise ValueError(f"Unexpected unit for nutrient {number}")
        amount = Decimal(str(item["amount"]))
        if not amount.is_finite() or amount < 0:
            raise ValueError("Invalid nutrient amount")
        if key in values and values[key] != amount:
            raise ValueError("Conflicting nutrient values")
        values[key] = amount
    if set(values) != {"calories", "protein", "carbs", "fat"}:
        raise ValueError("Missing required nutrient")
    if values["calories"] > 950 or any(values[k] > 100 for k in ("protein", "carbs", "fat")):
        raise ValueError("Implausible per-100-g nutrients")
    if sum(values[k] for k in ("protein", "carbs", "fat")) > 105:
        raise ValueError("Macronutrient mass exceeds 100 g tolerance")
    id = str(raw["fdcId"])
    if not id.isdigit() or raw["dataType"] != "SR Legacy":
        raise ValueError("Expected original USDA SR Legacy FDC ID")
    name = " ".join(raw["description"].split())
    return Food(
        id="usda-fdc-" + id,
        name=name,
        external_id=id,
        preparation=preparation,
        aliases=unique_aliases(name, aliases),
        per100g=Nutrients.model_validate(values),
        source_info=f"USDA FoodData Central, SR Legacy; FDC ID {id}; per 100 g edible portion; public domain (CC0); https://fdc.nal.usda.gov/food-details/{id}/nutrients",
    )


def validate_bundle(bundle):
    if set(bundle) != {"version", "items"} or bundle["version"] != 1:
        raise ValueError("Unsupported catalog bundle")
    ids, names, result = set(), set(), []
    for item in bundle["items"]:
        if set(item) != {"kind", "value"} or item["kind"] not in ("exercise", "food"):
            raise ValueError("Invalid catalog item")
        kind = item["kind"]
        value = (Exercise if kind == "exercise" else Food).model_validate(item["value"])
        expected = ("freeex-" if kind == "exercise" else "usda-fdc-") + (value.external_id or "")
        if not value.external_id or value.id != expected or not value.source_info:
            raise ValueError("Missing or inconsistent source identity")
        if isinstance(value, Exercise) and value.demo_url:
            raise ValueError("Exercise media is not approved")
        if isinstance(value, Food):
            # Reuse strict nutritional quality validation for edited bundles too.
            food_from_source(
                {
                    "fdcId": value.external_id,
                    "description": value.name,
                    "dataType": "SR Legacy",
                    "nutrients": [
                        {"number": n, "unit": u, "amount": getattr(value.per100g, k)}
                        for n, k, u in (
                            ("203", "protein", "G"),
                            ("204", "fat", "G"),
                            ("205", "carbs", "G"),
                            ("208", "calories", "KCAL"),
                        )
                    ],
                },
                value.preparation,
            )
        key = (kind, value.id)
        name_key = (kind, normalized(value.name), getattr(value, "preparation", None))
        if key in ids or name_key in names:
            raise ValueError("Duplicate source ID or normalized name/state")
        ids.add(key)
        names.add(name_key)
        result.append((kind, value))
    return result


def load_bundle(path=BUNDLE):
    return load_json(Path(path).read_bytes())


def import_catalog(ddb, table, bundle, *, apply=False, clock=utcnow):
    """Preflight every row, then conditional writes. A racing change fails closed.

    Mid-write conflicts may leave a partial import; rerun safely. No rollback deletes.
    """
    from .aws.dynamo import attributes, component, native, stamp

    models = validate_bundle(bundle)
    # Detect legacy/shared rows stored under another ID without inspecting private
    # partitions or deleting/merging records that existing histories may reference.
    existing_names: dict[tuple[str, str, str | None], set[str]] = {}
    existing_sources: dict[tuple[str, str], set[str]] = {}
    for kind in ("exercise", "food"):
        for page in ddb.get_paginator("query").paginate(
            TableName=table,
            KeyConditionExpression="#pk = :pk AND begins_with(#sk, :prefix)",
            ExpressionAttributeNames={"#pk": "PK", "#sk": "SK"},
            ExpressionAttributeValues=attributes({":pk": "TYPE#" + kind.upper(), ":prefix": "ID#"}),
            ConsistentRead=True,
        ):
            for row in page.get("Items", ()):
                data = load_json(native(row)["payload"])
                identity = data["id"]
                name_key = (kind, normalized(data["name"]), data.get("preparation"))
                existing_names.setdefault(name_key, set()).add(identity)
                external = data.get("external_id", data.get("externalId"))
                if external:
                    existing_sources.setdefault((kind, external), set()).add(identity)
    for kind, value in models:
        names = existing_names.get(
            (kind, normalized(value.name), getattr(value, "preparation", None)), set()
        )
        sources = existing_sources.get((kind, value.external_id), set())
        if (names | sources) - {value.id}:
            raise ValueError(
                "Duplicate existing shared name/state or source identity; no writes performed"
            )
    plan, report = [], Counter(create=0, update=0, unchanged=0, conflict=0)
    for kind, value in models:
        key = {"PK": "TYPE#" + kind.upper(), "SK": "ID#" + component(value.id)}
        response = ddb.get_item(TableName=table, Key=attributes(key), ConsistentRead=True)
        old = native(response["Item"]) if "Item" in response else None
        payload = json_text(value.model_dump())
        content_hash = digest(load_json(payload))
        action = "create"
        if old:
            if (
                old.get("catalogImporter") != IMPORTER
                or old.get("ownerSub") is not None
                or old.get("contentHash") != digest(load_json(old.get("payload", "{}")))
                or not isinstance(old.get("revision"), (int, Decimal))
                or isinstance(old.get("revision"), bool)
                or old["revision"] < 1
                or int(old["revision"]) != old["revision"]
                or not isinstance(old.get("created"), str)
            ):
                action = "conflict"
            else:
                action = "unchanged" if old["contentHash"] == content_hash else "update"
        report[action] += 1
        plan.append((key, payload, content_hash, old, action))
    if report["conflict"]:
        raise ValueError(
            f"Import blocked before writes: {report['conflict']} unmanaged/modified catalog rows"
        )
    if apply:
        for key, payload, content_hash, old, action in plan:
            if action == "unchanged":
                continue
            timestamp = stamp(clock())
            item = {
                **key,
                "payload": payload,
                "contentHash": content_hash,
                "catalogImporter": IMPORTER,
                "revision": int(old["revision"]) + 1 if old else 1,
                "created": old["created"] if old else timestamp,
                "updated": timestamp,
            }
            args = {"TableName": table, "Item": attributes(item)}
            if old:
                args.update(
                    ConditionExpression="#r = :r AND #h = :h AND #i = :i AND #p = :p",
                    ExpressionAttributeNames={
                        "#r": "revision",
                        "#h": "contentHash",
                        "#i": "catalogImporter",
                        "#p": "payload",
                    },
                    ExpressionAttributeValues=attributes(
                        {
                            ":r": old["revision"],
                            ":h": old["contentHash"],
                            ":i": IMPORTER,
                            ":p": old["payload"],
                        }
                    ),
                )
            else:
                args["ConditionExpression"] = (
                    "attribute_not_exists(PK) AND attribute_not_exists(SK)"
                )
            ddb.put_item(**args)
    return {"mode": "apply" if apply else "dry-run", "counts": dict(report), "items": len(plan)}
