"""The ruler: how much evidence that real people have paid a cost for this need.

Mirrors site/core.js `rulerScore` — tests check they agree.

    score = cost + dissatisfaction + pay + min(3, repetition - 1)        (0..12)

- cost / dissatisfaction / pay: 0-3 each, scored by the model from evidence in the post itself.
- repetition: independent sightings of the same need_key (counted by us, not judged by the model).
"""


def repetition_bonus(repetition):
    return max(0, min(3, int(repetition) - 1))


def score(rec, repetition=1):
    return int(rec.get("cost", 0)) + int(rec.get("dissatisfaction", 0)) + int(rec.get("pay", 0)) \
        + repetition_bonus(repetition)
