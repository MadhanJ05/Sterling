/**
 * Registry of every custom error in the project, so a revert can name itself.
 *
 * This exists as a registry rather than an import because decoding is needed in both places the
 * contracts run: the Node CLI, which compiles them with solc, and the browser build, which loads
 * pre-compiled artifacts. Importing the compiler to decode an error would drag solc and node:fs
 * into the web bundle.
 */
import { Interface, type InterfaceAbi } from "ethers";

let interfaces: Interface[] = [];

/** Called once at startup by whichever side has the artifacts. */
export function registerErrorAbis(abis: InterfaceAbi[]): void {
  interfaces = abis
    .map((abi) => {
      try { return new Interface(abi); } catch { return null; }
    })
    .filter((i): i is Interface => !!i);
}

export function knownErrorInterfaces(): Interface[] {
  return interfaces;
}
