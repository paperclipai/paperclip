export async function withIsolatedProfileCredentials(input) {
  for (const name of input.providerCredentialNames) {
    delete input.environment[name];
  }
  for (const [name, value] of Object.entries(input.profileCredentials)) {
    input.environment[name] = value;
  }
  try {
    return await input.run();
  } finally {
    for (const name of input.providerCredentialNames) {
      delete input.environment[name];
    }
  }
}
