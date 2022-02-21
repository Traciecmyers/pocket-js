import sha3 from 'js-sha3'
import { JsonRpcProvider } from '@pokt-foundation/pocketjs-provider'
import { AbstractSigner, KeyManager } from '@pokt-foundation/pocketjs-signer'
import {
  HTTPMethod,
  Node,
  PocketAAT,
  RelayHeaders,
  RelayMeta,
  RelayPayload,
  RelayResponse,
  RequestHash,
  Session,
  SessionHeader,
} from '@pokt-foundation/pocketjs-types'
import { AbstractRelayer } from './abstract-relayer'
import { validateRelayResponse } from './errors'

export class Relayer implements AbstractRelayer {
  readonly keyManager: KeyManager | AbstractSigner
  readonly provider: JsonRpcProvider
  readonly dispatchers: string[]

  constructor({ keyManager, provider, dispatchers }) {
    this.keyManager = keyManager
    this.provider = provider
    this.dispatchers = dispatchers
  }

  async getNewSession({
    applicationPubKey,
    chain,
    sessionBlockHeight = 0,
    options = {
      retryAttempts: 3,
      rejectSelfSignedCertificates: false,
      timeout: 5000,
    },
  }: {
    applicationPubKey?: string
    chain: string
    sessionBlockHeight?: number
    options?: {
      retryAttempts?: number
      rejectSelfSignedCertificates?: boolean
      timeout?: number
    }
  }): Promise<Session> {
    const dispatchResponse = await this.provider.dispatch({
      sessionHeader: {
        applicationPubKey: applicationPubKey ?? this.keyManager.getPublicKey(),
        chain,
        sessionBlockHeight: sessionBlockHeight ?? 0,
      },
    })

    return dispatchResponse.session as Session
  }

  static async relay({
    blockchain,
    data,
    headers = null,
    keyManager,
    method = '',
    node,
    path = '',
    pocketAAT,
    provider,
    session,
  }: {
    data: string
    blockchain: string
    pocketAAT: PocketAAT
    provider: JsonRpcProvider
    keyManager: KeyManager | AbstractSigner
    headers?: RelayHeaders | null
    method: HTTPMethod | ''
    session: Session
    node: Node
    path: string
  }) {
    if (!keyManager) {
      throw new Error('You need a signer to send a relay')
    }

    const serviceNode = node ?? Relayer.getRandomSessionNode(session)

    if (!serviceNode) {
      throw new Error(`Couldn't find a service node.`)
    }

    if (!this.isNodeInSession(session, serviceNode)) {
      throw new Error(`Node is not in the current session`)
    }

    const servicerPubKey = serviceNode.publicKey

    const relayPayload = {
      data,
      method,
      path,
      headers,
    } as RelayPayload

    const relayMeta = {
      block_height: Number(session.header.sessionBlockHeight.toString()),
    }

    const requestHash = {
      payload: relayPayload,
      meta: relayMeta,
    }

    const entropy = Number(BigInt(Math.floor(Math.random() * 99999999999999)))

    const proofBytes = this.generateProofBytes({
      entropy,
      sessionBlockHeight: Number(session.header.sessionBlockHeight.toString()),
      servicerPublicKey: servicerPubKey,
      blockchain,
      pocketAAT,
      requestHash,
    })
    const signedProofBytes = await keyManager.sign(proofBytes)

    const relayProof = {
      entropy: Number(entropy.toString()),
      session_block_height: Number(
        session.header.sessionBlockHeight.toString()
      ),
      servicer_pub_key: servicerPubKey,
      blockchain,
      aat: {
        version: pocketAAT.version,
        app_pub_key: pocketAAT.applicationPublicKey,
        client_pub_key: pocketAAT.clientPublicKey,
        signature: pocketAAT.applicationSignature,
      },
      signature: signedProofBytes,
      request_hash: this.hashRequest(requestHash),
    }

    const relayRequest = {
      payload: relayPayload,
      meta: relayMeta,
      proof: relayProof,
    }

    const relay = await provider.relay(
      relayRequest,
      serviceNode.serviceUrl.toString()
    )

    const relayResponse = validateRelayResponse(relay)

    return relayResponse
  }

  async relay({
    blockchain,
    data,
    headers = null,
    method = '',
    node,
    path = '',
    pocketAAT,
    session,
  }: {
    data: string
    blockchain: string
    pocketAAT: PocketAAT
    headers?: RelayHeaders | null
    method: HTTPMethod | ''
    session: Session
    node: Node
    path: string
  }) {
    if (!this.keyManager) {
      throw new Error('You need a signer to send a relay')
    }
    const serviceNode = node ?? undefined

    return Relayer.relay({
      blockchain,
      data,
      headers,
      method,
      node: serviceNode,
      path,
      pocketAAT,
      session,
      keyManager: this.keyManager,
      provider: this.provider,
    })
  }

  static getRandomSessionNode(session: Session): Node {
    const nodesInSession = session.nodes.length
    const rng = Math.floor(Math.random() * 100) % nodesInSession

    return session.nodes[rng]
  }

  static isNodeInSession(session: Session, node: Node): boolean {
    return Boolean(session.nodes.find((n) => n.publicKey === node.publicKey))
  }

  static generateProofBytes({
    entropy,
    sessionBlockHeight,
    servicerPublicKey,
    blockchain,
    pocketAAT,
    requestHash,
  }: {
    entropy: bigint | string | number
    sessionBlockHeight: string | number
    servicerPublicKey: string
    blockchain: string
    pocketAAT: PocketAAT
    requestHash: any
  }): string {
    const proofJSON = {
      entropy: Number(entropy.toString()),
      session_block_height: Number(sessionBlockHeight.toString()),
      servicer_pub_key: servicerPublicKey,
      blockchain: blockchain,
      signature: '',
      token: this.hashAAT(pocketAAT),
      request_hash: this.hashRequest(requestHash),
    }
    const proofJSONStr = JSON.stringify(proofJSON)
    // Hash proofJSONStr
    const hash = sha3.sha3_256.create()
    hash.update(proofJSONStr)
    return hash.hex()
  }

  static hashAAT(aat: PocketAAT): string {
    const token = {
      version: aat.version,
      app_pub_key: aat.applicationPublicKey,
      client_pub_key: aat.clientPublicKey,
      signature: '',
    }
    const hash = sha3.sha3_256.create()
    hash.update(JSON.stringify(token))
    return hash.hex()
  }

  static hashRequest(requestHash): string {
    const hash = sha3.sha3_256.create()
    hash.update(JSON.stringify(requestHash))
    return hash.hex()
  }
}