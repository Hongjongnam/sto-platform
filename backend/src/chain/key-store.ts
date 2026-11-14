import { HDNodeWallet, Mnemonic } from 'ethers';

/**
 * Custodial key store for local development and demos: every key is derived from one
 * mnemonic. Role keys use the indexes the deployment scripts assign; investor wallets are
 * handed out from `FIRST_INVESTOR_INDEX` upwards and remembered by index in the database.
 *
 * A production deployment would replace this with an HSM or a signing service behind the
 * same two methods.
 */
export class KeyStore {
  static readonly FIRST_INVESTOR_INDEX = 10;

  private readonly mnemonic: Mnemonic;
  private readonly byAddress = new Map<string, HDNodeWallet>();

  constructor(phrase: string) {
    this.mnemonic = Mnemonic.fromPhrase(phrase);
  }

  /** Wallet at `index` of the standard Ethereum derivation path. */
  derive(index: number): HDNodeWallet {
    const wallet = HDNodeWallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/${index}`);
    this.byAddress.set(wallet.address.toLowerCase(), wallet);
    return wallet;
  }

  /** Wallet for `address`, searching the first `searchLimit` indexes if it is not cached. */
  forAddress(address: string, searchLimit = 200): HDNodeWallet {
    const key = address.toLowerCase();
    const cached = this.byAddress.get(key);
    if (cached) return cached;
    for (let index = 0; index < searchLimit; index++) {
      if (this.derive(index).address.toLowerCase() === key) return this.byAddress.get(key)!;
    }
    throw new Error(`No key is held for ${address}`);
  }
}
