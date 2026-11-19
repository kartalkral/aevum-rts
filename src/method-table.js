// Compose method tables without instance wrappers or enumerable prototype methods.
export function installMethods(prototype, ...parts) {
  for (const part of parts) for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(part))) {
    if (Object.hasOwn(prototype, name)) throw new Error(`Duplicate method: ${name}`);
    Object.defineProperty(prototype, name, { ...descriptor, enumerable: false });
  }
}
