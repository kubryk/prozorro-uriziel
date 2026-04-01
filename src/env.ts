import dotenv from 'dotenv';

const ENV_REFERENCE_PATTERN = /\$\{([^}]+)\}/g;

function expandEnvValue(
  key: string,
  seenKeys = new Set<string>(),
): string | undefined {
  const rawValue = process.env[key];
  if (typeof rawValue !== 'string') {
    return rawValue;
  }

  if (seenKeys.has(key)) {
    return rawValue;
  }

  const nextSeenKeys = new Set(seenKeys);
  nextSeenKeys.add(key);

  const expandedValue = rawValue.replace(
    ENV_REFERENCE_PATTERN,
    (_match, referencedKey: string) => {
      const replacement = expandEnvValue(referencedKey, nextSeenKeys);
      if (typeof replacement !== 'string' || replacement.length === 0) {
        throw new Error(
          `Environment variable ${key} references ${referencedKey}, but ${referencedKey} is not set`,
        );
      }

      return replacement;
    },
  );

  process.env[key] = expandedValue;
  return expandedValue;
}

const result = dotenv.config();
const err = result.error as NodeJS.ErrnoException | undefined;

if (err && err.code !== 'ENOENT') {
  throw err;
}

Object.keys(result.parsed ?? {}).forEach((key) => {
  expandEnvValue(key);
});
