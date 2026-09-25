import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "amber", "autumn", "breezy", "bright", "calm", "cloudy", "coastal", "crisp",
  "dappled", "dewy", "distant", "drifting", "dusky", "early", "emerald", "frosty",
  "gentle", "gilded", "golden", "hazy", "hidden", "hushed", "icy", "jade",
  "lunar", "mellow", "misty", "mossy", "northern", "pale", "quiet", "rainy",
  "rolling", "rustling", "sandy", "silent", "silver", "soft", "southern", "sparkling",
  "still", "summer", "sunny", "twilight", "velvet", "wandering", "wintery", "woodland",
];

const NOUNS = [
  "aurora", "banksia", "blossom", "bluebell", "brook", "canyon", "cedar", "comet",
  "coral", "creek", "dawn", "dune", "fern", "fjord", "glacier", "grove",
  "harbour", "heron", "horizon", "island", "kestrel", "lagoon", "lake", "lichen",
  "marsh", "meadow", "nebula", "orchard", "otter", "pebble", "pine", "plover",
  "prairie", "quartz", "quokka", "reef", "ridge", "river", "snowfall", "sparrow",
  "spring", "summit", "sunrise", "thicket", "tide", "valley", "wattle", "willow",
  "wren",
];

export function codeName(pick = randomInt) {
  return `${ADJECTIVES[pick(ADJECTIVES.length)]}-${NOUNS[pick(NOUNS.length)]}`;
}
