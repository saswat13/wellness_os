"""Planning arithmetic only: USD/us-east-1, no AWS clients or billing queries."""

import json


def estimate(users):
    parts = {
        "httpApi": users * 4000 / 1_000_000,
        "lambda": users
        * (4000 * 0.20 / 1_000_000 + 2000 * 0.5 * (0.2 + 0.3) * 0.0000133334),
        "dynamoWrites": users * 40000 * 0.625 / 1_000_000,
        "dynamoReads": users * 40000 * 0.125 / 1_000_000,
        "dynamoStorage": (0.020 + users * 0.096) * 0.25,
        "pitr": (0.020 + users * 0.080) * 0.20,
        "logs": users * 0.008 * (0.50 + 0.03),
        "emailAllowance": users * 2 * 0.16 / 1000,
        "alarms": 15 * 0.10,
        "cursorSecret": 0.40 + 1000 * 0.05 / 10000,
        "staticS3": 0.5 * 0.023 + 2000 * 0.005 / 1000 + users * 30 * 0.0004 / 1000,
        "operationsAllowance": 0.01,
        "bootstrapS3": 0.5 * 0.023 + 100 * 0.005 / 1000,
        "cloudFrontEligibleAllowance": 0,
    }
    total = sum(parts.values())
    no_allowances = (
        total + users * 0.015 + users * 0.1 * 0.085 + users * 2300 * 0.01 / 10000
    )
    return {
        "mau": users,
        "components": {k: round(v, 4) for k, v in parts.items()},
        "eligibleCognitoAndCloudFront": round(total, 2),
        "bothAllowancesAlreadyConsumed": round(no_allowances, 2),
    }


if __name__ == "__main__":
    print(json.dumps([estimate(n) for n in (2, 100, 1000)], indent=2))
