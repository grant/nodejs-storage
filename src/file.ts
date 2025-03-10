/*!
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  BodyResponseCallback,
  DecorateRequestOptions,
  GetConfig,
  Interceptor,
  Metadata,
  ServiceObject,
  util,
} from '@google-cloud/common';
import {promisifyAll} from '@google-cloud/promisify';

import compressible = require('compressible');
import concat = require('concat-stream');
import * as crypto from 'crypto';
import * as dateFormat from 'date-and-time';
import * as extend from 'extend';
import * as fs from 'fs';
const hashStreamValidation = require('hash-stream-validation');
import * as mime from 'mime';
import * as once from 'onetime';
import * as os from 'os';
const pumpify = require('pumpify');
import * as resumableUpload from 'gcs-resumable-upload';
import {Duplex, Writable, Readable} from 'stream';
import * as streamEvents from 'stream-events';
import * as through from 'through2';
import * as xdgBasedir from 'xdg-basedir';
import * as querystring from 'querystring';
import * as zlib from 'zlib';
import * as url from 'url';
import * as http from 'http';

import {Storage} from './storage';
import {Bucket} from './bucket';
import {Acl} from './acl';
import {
  ResponseBody,
  ApiError,
  Duplexify,
  DuplexifyConstructor,
} from '@google-cloud/common/build/src/util';
const duplexify: DuplexifyConstructor = require('duplexify');
import {normalize, objectEntries} from './util';
import {GaxiosError, Headers, request as gaxiosRequest} from 'gaxios';

export type GetExpirationDateResponse = [Date];
export interface GetExpirationDateCallback {
  (
    err: Error | null,
    expirationDate?: Date | null,
    apiResponse?: Metadata
  ): void;
}

export interface GetSignedUrlConfig {
  action: 'read' | 'write' | 'delete' | 'resumable';
  version?: 'v2' | 'v4';
  cname?: string;
  contentMd5?: string;
  contentType?: string;
  expires: string | number | Date;
  extensionHeaders?: http.OutgoingHttpHeaders;
  promptSaveAs?: string;
  responseDisposition?: string;
  responseType?: string;
}

interface GetSignedUrlConfigInternal {
  expiration: number;
  method: string;
  name: string;
  resource?: string;
  extensionHeaders?: http.OutgoingHttpHeaders;
  contentMd5?: string;
  contentType?: string;
  promptSaveAs?: string;
  responseType?: string;
  responseDisposition?: string;
  cname?: string;
}

export enum ActionToHTTPMethod {
  read = 'GET',
  write = 'PUT',
  delete = 'DELETE',
  resumable = 'POST',
}

export type GetSignedUrlResponse = [string];

export interface GetSignedUrlCallback {
  (err: Error | null, url?: string): void;
}

export interface PolicyDocument {
  expiration: string;
  conditions: Array<Array<string | number>>;
  string: string;
}

export type GetSignedPolicyResponse = [PolicyDocument];

export interface GetSignedPolicyCallback {
  (err: Error | null, policy?: PolicyDocument): void;
}

export interface GetSignedPolicyOptions {
  equals?: string[] | string[][];
  expires: string | number | Date;
  startsWith?: string[] | string[][];
  acl?: string;
  successRedirect?: string;
  successStatus?: string;
  contentLengthRange?: {min?: number; max?: number};
}

export interface GetFileMetadataOptions {
  userProject?: string;
}

export type GetFileMetadataResponse = [Metadata, Metadata];

export interface GetFileMetadataCallback {
  (err: Error | null, metadata?: Metadata, apiResponse?: Metadata): void;
}

export interface GetFileOptions extends GetConfig {
  userProject?: string;
}

export type GetFileResponse = [File, Metadata];

export interface GetFileCallback {
  (err: Error | null, file?: File, apiResponse?: Metadata): void;
}

export interface FileExistsOptions {
  userProject?: string;
}

export type FileExistsResponse = [boolean];

export interface FileExistsCallback {
  (err: Error | null, exists?: boolean): void;
}

export interface DeleteFileOptions {
  userProject?: string;
}

export type DeleteFileResponse = [Metadata];

export interface DeleteFileCallback {
  (err: Error | null, apiResponse?: Metadata): void;
}

export type PredefinedAcl =
  | 'authenticatedRead'
  | 'bucketOwnerFullControl'
  | 'bucketOwnerRead'
  | 'private'
  | 'projectPrivate'
  | 'publicRead';

export interface CreateResumableUploadOptions {
  metadata?: Metadata;
  origin?: string;
  offset?: number;
  predefinedAcl?: PredefinedAcl;
  private?: boolean;
  public?: boolean;
  uri?: string;
  userProject?: string;
}

export type CreateResumableUploadResponse = [string];

export interface CreateResumableUploadCallback {
  (err: Error | null, uri?: string): void;
}

export interface CreateWriteStreamOptions extends CreateResumableUploadOptions {
  contentType?: string;
  gzip?: string | boolean;
  resumable?: boolean;
  validation?: string | boolean;
}

export interface MakeFilePrivateOptions {
  strict?: boolean;
  userProject?: string;
}

export type MakeFilePrivateResponse = [Metadata];

export interface MakeFilePrivateCallback extends SetFileMetadataCallback {}

export interface IsPublicCallback {
  (err: Error | null, resp?: boolean): void;
}

export type IsPublicResponse = [boolean];

export type MakeFilePublicResponse = [Metadata];

export interface MakeFilePublicCallback {
  (err?: Error | null, apiResponse?: Metadata): void;
}

export type MoveResponse = [Metadata];

export interface MoveCallback {
  (
    err: Error | null,
    destinationFile?: File | null,
    apiResponse?: Metadata
  ): void;
}

export interface MoveOptions {
  userProject?: string;
}

export type RotateEncryptionKeyOptions = string | Buffer | EncryptionKeyOptions;

export interface EncryptionKeyOptions {
  encryptionKey?: string | Buffer;
  kmsKeyName?: string;
}

export interface RotateEncryptionKeyCallback extends CopyCallback {}

export type RotateEncryptionKeyResponse = CopyResponse;

/**
 * Custom error type for errors related to creating a resumable upload.
 *
 * @private
 */
class ResumableUploadError extends Error {
  name = 'ResumableUploadError';
}

/**
 * Custom error type for errors related to getting signed errors and policies.
 *
 * @private
 */
class SigningError extends Error {
  name = 'SigningError';
}

/**
 * @const {string}
 * @private
 */
const STORAGE_DOWNLOAD_BASE_URL = 'https://storage.googleapis.com';

/**
 * @const {string}
 * @private
 */
const STORAGE_UPLOAD_BASE_URL =
  'https://www.googleapis.com/upload/storage/v1/b';

/**
 * @const {RegExp}
 * @private
 */
const GS_URL_REGEXP = /^gs:\/\/([a-z0-9_.-]+)\/(.+)$/;

export interface FileOptions {
  encryptionKey?: string | Buffer;
  generation?: number | string;
  kmsKeyName?: string;
  userProject?: string;
}

export interface CopyOptions {
  destinationKmsKeyName?: string;
  keepAcl?: string;
  predefinedAcl?: string;
  token?: string;
  userProject?: string;
}

export type CopyResponse = [File, Metadata];

export interface CopyCallback {
  (err: Error | null, file?: File | null, apiResponse?: Metadata): void;
}

export type DownloadResponse = [Buffer];

export type DownloadCallback = (
  err: RequestError | null,
  contents: Buffer
) => void;

export interface DownloadOptions extends CreateReadStreamOptions {
  destination?: string;
}

interface CopyQuery {
  sourceGeneration?: number;
  rewriteToken?: string;
  userProject?: string;
  destinationKmsKeyName?: string;
}

interface FileQuery {
  alt: string;
  generation?: number;
  userProject?: string;
}

interface SignedUrlQuery {
  generation?: number;
  'response-content-type'?: string;
  'response-content-disposition'?: string;
}

interface V2SignedUrlQuery extends SignedUrlQuery {
  GoogleAccessId: string;
  Expires: number;
  Signature: string;
}

interface V4UrlQuery extends SignedUrlQuery {
  'X-Goog-Algorithm': string;
  'X-Goog-Credential': string;
  'X-Goog-Date': string;
  'X-Goog-Expires': number;
  'X-Goog-SignedHeaders': string;
}

interface V4SignedUrlQuery extends V4UrlQuery {
  'X-Goog-Signature': string;
}

export interface CreateReadStreamOptions {
  userProject?: string;
  validation?: 'md5' | 'crc32c' | false | true;
  start?: number;
  end?: number;
}

export interface SaveOptions extends CreateWriteStreamOptions {}

export interface SaveCallback {
  (err?: Error | null): void;
}

export interface SetFileMetadataOptions {
  userProject?: string;
}

export interface SetFileMetadataCallback {
  (err?: Error | null, apiResponse?: Metadata): void;
}

export type SetFileMetadataResponse = [Metadata];

export type SetStorageClassResponse = [Metadata];

export interface SetStorageClassOptions {
  userProject?: string;
}

interface SetStorageClassRequest extends SetStorageClassOptions {
  storageClass?: string;
}

export interface SetStorageClassCallback {
  (err?: Error | null, apiResponse?: Metadata): void;
}

class RequestError extends Error {
  code?: string;
  errors?: Error[];
}

type ValueOf<T> = T[keyof T];
type HeaderValue = ValueOf<http.OutgoingHttpHeaders>;

const SEVEN_DAYS = 604800;

/*
 * Default signing version for getSignedUrl is 'v2'.
 */
const DEFAULT_SIGNING_VERSION = 'v2';

/**
 * A File object is created from your {@link Bucket} object using
 * {@link Bucket#file}.
 *
 * @class
 */
class File extends ServiceObject<File> {
  /**
   * Cloud Storage uses access control lists (ACLs) to manage object and
   * bucket access. ACLs are the mechanism you use to share objects with other
   * users and allow other users to access your buckets and objects.
   *
   * An ACL consists of one or more entries, where each entry grants permissions
   * to an entity. Permissions define the actions that can be performed against
   * an object or bucket (for example, `READ` or `WRITE`); the entity defines
   * who the permission applies to (for example, a specific user or group of
   * users).
   *
   * The `acl` object on a File instance provides methods to get you a list of
   * the ACLs defined on your bucket, as well as set, update, and delete them.
   *
   * @see [About Access Control lists]{@link http://goo.gl/6qBBPO}
   *
   * @name File#acl
   * @mixes Acl
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   * //-
   * // Make a file publicly readable.
   * //-
   * const options = {
   *   entity: 'allUsers',
   *   role: storage.acl.READER_ROLE
   * };
   *
   * file.acl.add(options, function(err, aclObject) {});
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.acl.add(options).then(function(data) {
   *   const aclObject = data[0];
   *   const apiResponse = data[1];
   * });
   */
  acl: Acl;

  bucket: Bucket;
  storage: Storage;
  kmsKeyName?: string;
  userProject?: string;
  name: string;
  generation?: number;
  parent!: Bucket;

  private encryptionKey?: string | Buffer;
  private encryptionKeyBase64?: string;
  private encryptionKeyHash?: string;
  private encryptionKeyInterceptor?: Interceptor;

  /**
   * @typedef {object} FileOptions Options passed to the File constructor.
   * @property {string} [encryptionKey] A custom encryption key.
   * @property {number} [generation] Generation to scope the file to.
   * @property {string} [kmsKeyName] Cloud KMS Key used to encrypt this
   *     object, if the object is encrypted by such a key. Limited availability;
   *     usable only by enabled projects.
   * @property {string} [userProject] The ID of the project which will be
   *     billed for all requests made from File object.
   */
  /**
   * Constructs a file object.
   *
   * @param {Bucket} bucket The Bucket instance this file is
   *     attached to.
   * @param {string} name The name of the remote file.
   * @param {FileOptions} [options] Configuration options.
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   */
  constructor(bucket: Bucket, name: string, options: FileOptions = {}) {
    name = name.replace(/^\/+/, '');

    const requestQueryObject: {generation?: number; userProject?: string} = {};

    let generation: number;
    if (options.generation != null) {
      if (typeof options.generation === 'string') {
        generation = Number(options.generation);
      } else {
        generation = options.generation;
      }
      if (!isNaN(generation)) {
        requestQueryObject.generation = generation;
      }
    }

    const userProject = options.userProject || bucket.userProject;
    if (typeof userProject === 'string') {
      requestQueryObject.userProject = userProject;
    }

    const methods = {
      /**
       * @typedef {array} DeleteFileResponse
       * @property {object} 0 The full API response.
       */
      /**
       * @callback DeleteFileCallback
       * @param {?Error} err Request error, if any.
       * @param {object} apiResponse The full API response.
       */
      /**
       * Delete the file.
       *
       * @see [Objects: delete API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/delete}
       *
       * @method File#delete
       * @param {object} [options] Configuration options.
       * @param {string} [options.userProject] The ID of the project which will be
       *     billed for the request.
       * @param {DeleteFileCallback} [callback] Callback function.
       * @returns {Promise<DeleteFileResponse>}
       *
       * @example
       * const {Storage} = require('@google-cloud/storage');
       * const storage = new Storage();
       * const myBucket = storage.bucket('my-bucket');
       *
       * const file = myBucket.file('my-file');
       * file.delete(function(err, apiResponse) {});
       *
       * //-
       * // If the callback is omitted, we'll return a Promise.
       * //-
       * file.delete().then(function(data) {
       *   const apiResponse = data[0];
       * });
       *
       * @example <caption>include:samples/files.js</caption>
       * region_tag:storage_delete_file
       * Another example:
       */
      delete: {
        reqOpts: {
          qs: requestQueryObject,
        },
      },
      /**
       * @typedef {array} FileExistsResponse
       * @property {boolean} 0 Whether the {@link File} exists.
       */
      /**
       * @callback FileExistsCallback
       * @param {?Error} err Request error, if any.
       * @param {boolean} exists Whether the {@link File} exists.
       */
      /**
       * Check if the file exists.
       *
       * @method File#exists
       * @param {options} [options] Configuration options.
       * @param {string} [options.userProject] The ID of the project which will be
       *     billed for the request.
       * @param {FileExistsCallback} [callback] Callback function.
       * @returns {Promise<FileExistsResponse>}
       *
       * @example
       * const {Storage} = require('@google-cloud/storage');
       * const storage = new Storage();
       * const myBucket = storage.bucket('my-bucket');
       *
       * const file = myBucket.file('my-file');
       *
       * file.exists(function(err, exists) {});
       *
       * //-
       * // If the callback is omitted, we'll return a Promise.
       * //-
       * file.exists().then(function(data) {
       *   const exists = data[0];
       * });
       */
      exists: {
        reqOpts: {
          qs: requestQueryObject,
        },
      },
      /**
       * @typedef {array} GetFileResponse
       * @property {File} 0 The {@link File}.
       * @property {object} 1 The full API response.
       */
      /**
       * @callback GetFileCallback
       * @param {?Error} err Request error, if any.
       * @param {File} file The {@link File}.
       * @param {object} apiResponse The full API response.
       */
      /**
       * Get a file object and its metadata if it exists.
       *
       * @method File#get
       * @param {options} [options] Configuration options.
       * @param {string} [options.userProject] The ID of the project which will be
       *     billed for the request.
       * @param {GetFileCallback} [callback] Callback function.
       * @returns {Promise<GetFileResponse>}
       *
       * @example
       * const {Storage} = require('@google-cloud/storage');
       * const storage = new Storage();
       * const myBucket = storage.bucket('my-bucket');
       *
       * const file = myBucket.file('my-file');
       *
       * file.get(function(err, file, apiResponse) {
       *   // file.metadata` has been populated.
       * });
       *
       * //-
       * // If the callback is omitted, we'll return a Promise.
       * //-
       * file.get().then(function(data) {
       *   const file = data[0];
       *   const apiResponse = data[1];
       * });
       */
      get: {
        reqOpts: {
          qs: requestQueryObject,
        },
      },
      /**
       * @typedef {array} GetFileMetadataResponse
       * @property {object} 0 The {@link File} metadata.
       * @property {object} 1 The full API response.
       */
      /**
       * @callback GetFileMetadataCallback
       * @param {?Error} err Request error, if any.
       * @param {object} metadata The {@link File} metadata.
       * @param {object} apiResponse The full API response.
       */
      /**
       * Get the file's metadata.
       *
       * @see [Objects: get API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/get}
       *
       * @method File#getMetadata
       * @param {object} [options] Configuration options.
       * @param {string} [options.userProject] The ID of the project which will be
       *     billed for the request.
       * @param {GetFileMetadataCallback} [callback] Callback function.
       * @returns {Promise<GetFileMetadataResponse>}
       *
       * @example
       * const {Storage} = require('@google-cloud/storage');
       * const storage = new Storage();
       * const myBucket = storage.bucket('my-bucket');
       *
       * const file = myBucket.file('my-file');
       *
       * file.getMetadata(function(err, metadata, apiResponse) {});
       *
       * //-
       * // If the callback is omitted, we'll return a Promise.
       * //-
       * file.getMetadata().then(function(data) {
       *   const metadata = data[0];
       *   const apiResponse = data[1];
       * });
       *
       * @example <caption>include:samples/files.js</caption>
       * region_tag:storage_get_metadata
       * Another example:
       */
      getMetadata: {
        reqOpts: {
          qs: requestQueryObject,
        },
      },
      /**
       * @typedef {object} SetFileMetadataOptions Configuration options for File#setMetadata().
       * @param {string} [userProject] The ID of the project which will be billed for the request.
       */
      /**
       * @callback SetFileMetadataCallback
       * @param {?Error} err Request error, if any.
       * @param {object} apiResponse The full API response.
       */
      /**
       * @typedef {array} SetFileMetadataResponse
       * @property {object} 0 The full API response.
       */
      /**
       * Merge the given metadata with the current remote file's metadata. This
       * will set metadata if it was previously unset or update previously set
       * metadata. To unset previously set metadata, set its value to null.
       *
       * You can set custom key/value pairs in the metadata key of the given
       * object, however the other properties outside of this object must adhere
       * to the [official API documentation](https://goo.gl/BOnnCK).
       *
       * NOTE: multiple calls to setMetadata in parallel might result in
       * unpredictable results. See [issue]{@link
       * https://github.com/googleapis/nodejs-storage/issues/274}.
       *
       * See the examples below for more information.
       *
       * @see [Objects: patch API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/patch}
       *
       * @method File#setMetadata
       * @param {object} [metadata] The metadata you wish to update.
       * @param {SetFileMetadataOptions} [options] Configuration options.
       * @param {SetFileMetadataCallback} [callback] Callback function.
       * @returns {Promise<SetFileMetadataResponse>}
       *
       * @example
       * const {Storage} = require('@google-cloud/storage');
       * const storage = new Storage();
       * const myBucket = storage.bucket('my-bucket');
       *
       * const file = myBucket.file('my-file');
       *
       * const metadata = {
       *   contentType: 'application/x-font-ttf',
       *   metadata: {
       *     my: 'custom',
       *     properties: 'go here'
       *   }
       * };
       *
       * file.setMetadata(metadata, function(err, apiResponse) {});
       *
       * // Assuming current metadata = { hello: 'world', unsetMe: 'will do' }
       * file.setMetadata({
       *   metadata: {
       *     abc: '123', // will be set.
       *     unsetMe: null, // will be unset (deleted).
       *     hello: 'goodbye' // will be updated from 'world' to 'goodbye'.
       *   }
       * }, function(err, apiResponse) {
       *   // metadata should now be { abc: '123', hello: 'goodbye' }
       * });
       *
       * //-
       * // Set a temporary hold on this file from its bucket's retention period
       * // configuration.
       * //
       * file.setMetadata({
       *   temporaryHold: true
       * }, function(err, apiResponse) {});
       *
       * //-
       * // Alternatively, you may set a temporary hold. This will follow the
       * // same behavior as an event-based hold, with the exception that the
       * // bucket's retention policy will not renew for this file from the time
       * // the hold is released.
       * //-
       * file.setMetadata({
       *   eventBasedHold: true
       * }, function(err, apiResponse) {});
       *
       * //-
       * // If the callback is omitted, we'll return a Promise.
       * //-
       * file.setMetadata(metadata).then(function(data) {
       *   const apiResponse = data[0];
       * });
       */
      setMetadata: {
        reqOpts: {
          qs: requestQueryObject,
        },
      },
    };

    super({
      parent: bucket,
      baseUrl: '/o',
      id: encodeURIComponent(name),
      methods,
    });

    this.bucket = bucket;
    // tslint:disable-next-line:no-any
    this.storage = (bucket as any).parent as Storage;

    // @TODO Can this duplicate code from above be avoided?
    if (options.generation != null) {
      let generation: number;
      if (typeof options.generation === 'string') {
        generation = Number(options.generation);
      } else {
        generation = options.generation;
      }
      if (!isNaN(generation)) {
        this.generation = generation;
      }
    }
    this.kmsKeyName = options.kmsKeyName;
    this.userProject = userProject;

    this.name = name;

    if (options.encryptionKey) {
      this.setEncryptionKey(options.encryptionKey);
    }

    this.acl = new Acl({
      request: this.request.bind(this),
      pathPrefix: '/acl',
    });
  }

  copy(destination: string | Bucket | File): Promise<CopyResponse>;
  copy(destination: string | Bucket | File, callback: CopyCallback): void;
  copy(
    destination: string | Bucket | File,
    options: CopyOptions,
    callback: CopyCallback
  ): void;
  /**
   * @typedef {array} CopyResponse
   * @property {File} 0 The copied {@link File}.
   * @property {object} 1 The full API response.
   */
  /**
   * @callback CopyCallback
   * @param {?Error} err Request error, if any.
   * @param {File} copiedFile The copied {@link File}.
   * @param {object} apiResponse The full API response.
   */
  /**
   * @typedef {object} CopyOptions Configuration options for File#copy(). See an
   *     [Object
   * resource](https://cloud.google.com/storage/docs/json_api/v1/objects#resource).
   * @property {string} [destinationKmsKeyName] Resource name of the Cloud
   *     KMS key, of the form
   *     `projects/my-project/locations/location/keyRings/my-kr/cryptoKeys/my-key`,
   *     that will be used to encrypt the object. Overwrites the object
   * metadata's `kms_key_name` value, if any.
   * @property {string} [keepAcl] Retain the ACL for the new file.
   * @property {string} [predefinedAcl] Set the ACL for the new file.
   * @property {string} [token] A previously-returned `rewriteToken` from an
   *     unfinished rewrite request.
   * @property {string} [userProject] The ID of the project which will be
   *     billed for the request.
   */
  /**
   * Copy this file to another file. By default, this will copy the file to the
   * same bucket, but you can choose to copy it to another Bucket by providing
   * a Bucket or File object or a URL starting with "gs://".
   *
   * @see [Objects: rewrite API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/rewrite}
   *
   * @throws {Error} If the destination file is not provided.
   *
   * @param {string|Bucket|File} destination Destination file.
   * @param {CopyOptions} [options] Configuration options. See an
   * @param {CopyCallback} [callback] Callback function.
   * @returns {Promise<CopyResponse>}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   *
   * //-
   * // You can pass in a variety of types for the destination.
   * //
   * // For all of the below examples, assume we are working with the following
   * // Bucket and File objects.
   * //-
   * const bucket = storage.bucket('my-bucket');
   * const file = bucket.file('my-image.png');
   *
   * //-
   * // If you pass in a string for the destination, the file is copied to its
   * // current bucket, under the new name provided.
   * //-
   * file.copy('my-image-copy.png', function(err, copiedFile, apiResponse) {
   *   // `my-bucket` now contains:
   *   // - "my-image.png"
   *   // - "my-image-copy.png"
   *
   *   // `copiedFile` is an instance of a File object that refers to your new
   *   // file.
   * });
   *
   * //-
   * // If you pass in a string starting with "gs://" for the destination, the
   * // file is copied to the other bucket and under the new name provided.
   * //-
   * const newLocation = 'gs://another-bucket/my-image-copy.png';
   * file.copy(newLocation, function(err, copiedFile, apiResponse) {
   *   // `my-bucket` still contains:
   *   // - "my-image.png"
   *   //
   *   // `another-bucket` now contains:
   *   // - "my-image-copy.png"
   *
   *   // `copiedFile` is an instance of a File object that refers to your new
   *   // file.
   * });
   *
   * //-
   * // If you pass in a Bucket object, the file will be copied to that bucket
   * // using the same name.
   * //-
   * const anotherBucket = storage.bucket('another-bucket');
   * file.copy(anotherBucket, function(err, copiedFile, apiResponse) {
   *   // `my-bucket` still contains:
   *   // - "my-image.png"
   *   //
   *   // `another-bucket` now contains:
   *   // - "my-image.png"
   *
   *   // `copiedFile` is an instance of a File object that refers to your new
   *   // file.
   * });
   *
   * //-
   * // If you pass in a File object, you have complete control over the new
   * // bucket and filename.
   * //-
   * const anotherFile = anotherBucket.file('my-awesome-image.png');
   * file.copy(anotherFile, function(err, copiedFile, apiResponse) {
   *   // `my-bucket` still contains:
   *   // - "my-image.png"
   *   //
   *   // `another-bucket` now contains:
   *   // - "my-awesome-image.png"
   *
   *   // Note:
   *   // The `copiedFile` parameter is equal to `anotherFile`.
   * });
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.copy(newLocation).then(function(data) {
   *   const newFile = data[0];
   *   const apiResponse = data[1];
   * });
   *
   * @example <caption>include:samples/files.js</caption>
   * region_tag:storage_copy_file
   * Another example:
   */
  copy(
    destination: string | Bucket | File,
    optionsOrCallback?: CopyOptions | CopyCallback,
    callback?: CopyCallback
  ): Promise<CopyResponse> | void {
    const noDestinationError = new Error(
      'Destination file should have a name.'
    );

    if (!destination) {
      throw noDestinationError;
    }

    let options: CopyOptions = {};
    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
    } else if (optionsOrCallback) {
      options = optionsOrCallback;
    }

    options = extend(true, {}, options);
    callback = callback || util.noop;

    let destBucket: Bucket;
    let destName: string;
    let newFile: File;

    if (typeof destination === 'string') {
      const parsedDestination = GS_URL_REGEXP.exec(destination);
      if (parsedDestination !== null && parsedDestination.length === 3) {
        destBucket = this.storage.bucket(parsedDestination[1]);
        destName = parsedDestination[2];
      } else {
        destBucket = this.bucket;
        destName = destination;
      }
    } else if (destination instanceof Bucket) {
      destBucket = destination;
      destName = this.name;
    } else if (destination instanceof File) {
      destBucket = destination.bucket;
      destName = destination.name;
      newFile = destination;
    } else {
      throw noDestinationError;
    }

    const query = {} as CopyQuery;
    if (this.generation !== undefined) {
      query.sourceGeneration = this.generation;
    }
    if (options.token !== undefined) {
      query.rewriteToken = options.token;
    }
    if (options.userProject !== undefined) {
      query.userProject = options.userProject;
      delete options.userProject;
    }

    newFile = newFile! || destBucket.file(destName);

    const headers: {[index: string]: string | undefined} = {};

    if (this.encryptionKey !== undefined) {
      headers['x-goog-copy-source-encryption-algorithm'] = 'AES256';
      headers['x-goog-copy-source-encryption-key'] = this.encryptionKeyBase64;
      headers[
        'x-goog-copy-source-encryption-key-sha256'
      ] = this.encryptionKeyHash;
    }

    if (newFile.encryptionKey !== undefined) {
      this.setEncryptionKey(newFile.encryptionKey!);
    } else if (options.destinationKmsKeyName !== undefined) {
      query.destinationKmsKeyName = options.destinationKmsKeyName;
      delete options.destinationKmsKeyName;
    } else if (newFile.kmsKeyName !== undefined) {
      query.destinationKmsKeyName = newFile.kmsKeyName;
    }

    if (query.destinationKmsKeyName) {
      this.kmsKeyName = query.destinationKmsKeyName;

      const keyIndex = this.interceptors.indexOf(
        this.encryptionKeyInterceptor!
      );
      if (keyIndex > -1) {
        this.interceptors.splice(keyIndex, 1);
      }
    }

    this.request(
      {
        method: 'POST',
        uri: `/rewriteTo/b/${destBucket.name}/o/${encodeURIComponent(
          newFile.name
        )}`,
        qs: query,
        json: options,
        headers,
      },
      (err, resp) => {
        if (err) {
          callback!(err, null, resp);
          return;
        }

        if (resp.rewriteToken) {
          const options = {
            token: resp.rewriteToken,
          } as CopyOptions;

          if (query.userProject) {
            options.userProject = query.userProject;
          }

          if (query.destinationKmsKeyName) {
            options.destinationKmsKeyName = query.destinationKmsKeyName;
          }

          this.copy(newFile, options, callback!);
          return;
        }

        callback!(null, newFile, resp);
      }
    );
  }

  /**
   * @typedef {object} CreateReadStreamOptions Configuration options for File#createReadStream.
   * @property {string} [userProject] The ID of the project which will be
   *     billed for the request.
   * @property {string|boolean} [validation] Possible values: `"md5"`,
   *     `"crc32c"`, or `false`. By default, data integrity is validated with a
   *     CRC32c checksum. You may use MD5 if preferred, but that hash is not
   *     supported for composite objects. An error will be raised if MD5 is
   *     specified but is not available. You may also choose to skip validation
   *     completely, however this is **not recommended**.
   * @property {number} [start] A byte offset to begin the file's download
   *     from. Default is 0. NOTE: Byte ranges are inclusive; that is,
   *     `options.start = 0` and `options.end = 999` represent the first 1000
   *     bytes in a file or object. NOTE: when specifying a byte range, data
   *     integrity is not available.
   * @property {number} [end] A byte offset to stop reading the file at.
   *     NOTE: Byte ranges are inclusive; that is, `options.start = 0` and
   *     `options.end = 999` represent the first 1000 bytes in a file or object.
   *     NOTE: when specifying a byte range, data integrity is not available.
   */
  /**
   * Create a readable stream to read the contents of the remote file. It can be
   * piped to a writable stream or listened to for 'data' events to read a
   * file's contents.
   *
   * In the unlikely event there is a mismatch between what you downloaded and
   * the version in your Bucket, your error handler will receive an error with
   * code "CONTENT_DOWNLOAD_MISMATCH". If you receive this error, the best
   * recourse is to try downloading the file again.
   *
   * For faster crc32c computation, you must manually install
   * [`fast-crc32c`](http://www.gitnpm.com/fast-crc32c):
   *
   *     $ npm install --save fast-crc32c
   *
   * NOTE: Readable streams will emit the `end` event when the file is fully
   * downloaded.
   *
   * @param {CreateReadStreamOptions} [options] Configuration options.
   * @returns {ReadableStream}
   *
   * @example
   * //-
   * // <h4>Downloading a File</h4>
   * //
   * // The example below demonstrates how we can reference a remote file, then
   * // pipe its contents to a local file. This is effectively creating a local
   * // backup of your remote data.
   * //-
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const bucket = storage.bucket('my-bucket');
   *
   * const fs = require('fs');
   * const remoteFile = bucket.file('image.png');
   * const localFilename = '/Users/stephen/Photos/image.png';
   *
   * remoteFile.createReadStream()
   *   .on('error', function(err) {})
   *   .on('response', function(response) {
   *     // Server connected and responded with the specified status and
   * headers.
   *    })
   *   .on('end', function() {
   *     // The file is fully downloaded.
   *   })
   *   .pipe(fs.createWriteStream(localFilename));
   *
   * //-
   * // To limit the downloaded data to only a byte range, pass an options
   * object.
   * //-
   * const logFile = myBucket.file('access_log');
   * logFile.createReadStream({
   *     start: 10000,
   *     end: 20000
   *   })
   *   .on('error', function(err) {})
   *   .pipe(fs.createWriteStream('/Users/stephen/logfile.txt'));
   *
   * //-
   * // To read a tail byte range, specify only `options.end` as a negative
   * // number.
   * //-
   * const logFile = myBucket.file('access_log');
   * logFile.createReadStream({
   *     end: -100
   *   })
   *   .on('error', function(err) {})
   *   .pipe(fs.createWriteStream('/Users/stephen/logfile.txt'));
   */
  createReadStream(options: CreateReadStreamOptions = {}): Readable {
    const rangeRequest =
      typeof options.start === 'number' || typeof options.end === 'number';
    const tailRequest = options.end! < 0;

    // tslint:disable-next-line:no-any
    let validateStream: any; // Created later, if necessary.
    const throughStream = streamEvents(through()) as Duplex;

    let crc32c = true;
    let md5 = false;

    let refreshedMetadata = false;

    if (typeof options.validation === 'string') {
      // tslint:disable-next-line:no-any
      (options as any).validation = (options.validation as string).toLowerCase();
      crc32c = options.validation === 'crc32c';
      md5 = options.validation === 'md5';
    } else if (options.validation === false) {
      crc32c = false;
    }

    if (rangeRequest) {
      if (
        typeof options.validation === 'string' ||
        options.validation === true
      ) {
        throw new Error('Cannot use validation with file ranges (start/end).');
      }
      // Range requests can't receive data integrity checks.
      crc32c = false;
      md5 = false;
    }

    // Authenticate the request, then pipe the remote API request to the stream
    // returned to the user.
    const makeRequest = () => {
      const query = {
        alt: 'media',
      } as FileQuery;

      if (this.generation) {
        query.generation = this.generation;
      }

      if (options.userProject) {
        query.userProject = options.userProject;
      }

      const headers = {
        'Accept-Encoding': 'gzip',
        'Cache-Control': 'no-store',
      } as Headers;

      if (rangeRequest) {
        const start = typeof options.start === 'number' ? options.start : '0';
        const end = typeof options.end === 'number' ? options.end : '';

        headers.Range = `bytes=${tailRequest ? end : `${start}-${end}`}`;
      }

      const reqOpts = {
        forever: false,
        uri: '',
        headers,
        qs: query,
      };

      this.requestStream(reqOpts)
        .on('error', err => {
          throughStream.destroy(err);
        })
        .on('response', res => {
          throughStream.emit('response', res);
          // tslint:disable-next-line:no-any
          util.handleResp(null, res, null, onResponse as any);
        })
        .resume();

      // We listen to the response event from the request stream so that we
      // can...
      //
      //   1) Intercept any data from going to the user if an error occurred.
      //   2) Calculate the hashes from the http.IncomingMessage response
      //   stream,
      //      which will return the bytes from the source without decompressing
      //      gzip'd content. We then send it through decompressed, if
      //      applicable, to the user.
      const onResponse = (
        err: Error | null,
        body: ResponseBody,
        rawResponseStream: Metadata
      ) => {
        if (err) {
          // Get error message from the body.
          rawResponseStream.pipe(
            concat(body => {
              err.message = body.toString();
              throughStream.destroy(err);
            })
          );

          return;
        }

        rawResponseStream.on('error', onComplete);

        const headers = rawResponseStream.toJSON().headers;
        const isCompressed = headers['content-encoding'] === 'gzip';
        const shouldRunValidation = !rangeRequest && (crc32c || md5);
        const throughStreams: Writable[] = [];

        if (shouldRunValidation) {
          validateStream = hashStreamValidation({crc32c, md5});
          throughStreams.push(validateStream);
        }

        if (isCompressed) {
          throughStreams.push(zlib.createGunzip());
        }

        if (throughStreams.length === 1) {
          rawResponseStream =
            // tslint:disable-next-line:no-any
            rawResponseStream.pipe(throughStreams[0]) as any;
        } else if (throughStreams.length > 1) {
          rawResponseStream = rawResponseStream.pipe(
            pumpify.obj(throughStreams)
          );
        }

        rawResponseStream
          .on('error', onComplete)
          .on('end', onComplete)
          .pipe(
            throughStream,
            {end: false}
          );
      };

      // This is hooked to the `complete` event from the request stream. This is
      // our chance to validate the data and let the user know if anything went
      // wrong.
      let onCompleteCalled = false;
      const onComplete = (err: Error | null) => {
        if (err) {
          onCompleteCalled = true;
          throughStream.destroy(err);
          return;
        }

        if (rangeRequest) {
          onCompleteCalled = true;
          throughStream.end();
          return;
        }

        if (!refreshedMetadata) {
          refreshedMetadata = true;
          this.getMetadata({userProject: options.userProject}, onComplete);
          return;
        }

        if (onCompleteCalled) {
          return;
        }

        onCompleteCalled = true;

        const hashes = {
          crc32c: this.metadata.crc32c,
          md5: this.metadata.md5Hash,
        };

        // If we're doing validation, assume the worst-- a data integrity
        // mismatch. If not, these tests won't be performed, and we can assume
        // the best.
        let failed = crc32c || md5;

        if (crc32c && hashes.crc32c) {
          // We must remove the first four bytes from the returned checksum.
          // http://stackoverflow.com/questions/25096737/
          //   base64-encoding-of-crc32c-long-value
          failed = !validateStream.test('crc32c', hashes.crc32c.substr(4));
        }

        if (md5 && hashes.md5) {
          failed = !validateStream.test('md5', hashes.md5);
        }

        if (md5 && !hashes.md5) {
          const hashError = new RequestError(
            [
              'MD5 verification was specified, but is not available for the',
              'requested object. MD5 is not available for composite objects.',
            ].join(' ')
          );
          hashError.code = 'MD5_NOT_AVAILABLE';

          throughStream.destroy(hashError);
        } else if (failed) {
          const mismatchError = new RequestError(
            [
              'The downloaded data did not match the data from the server.',
              'To be sure the content is the same, you should download the',
              'file again.',
            ].join(' ')
          );
          mismatchError.code = 'CONTENT_DOWNLOAD_MISMATCH';

          throughStream.destroy(mismatchError);
        } else {
          throughStream.end();
        }
      };
    };

    throughStream.on('reading', makeRequest);

    return throughStream as Readable;
  }

  createResumableUpload(
    options?: CreateResumableUploadOptions
  ): Promise<CreateResumableUploadResponse>;
  createResumableUpload(
    options: CreateResumableUploadOptions,
    callback: CreateResumableUploadCallback
  ): void;
  createResumableUpload(callback: CreateResumableUploadCallback): void;
  /**
   * @callback CreateResumableUploadCallback
   * @param {?Error} err Request error, if any.
   * @param {string} uri The resumable upload's unique session URI.
   */
  /**
   * @typedef {array} CreateResumableUploadResponse
   * @property {string} 0 The resumable upload's unique session URI.
   */
  /**
   * @typedef {object} CreateResumableUploadOptions
   * @property {object} [metadata] Metadata to set on the file.
   * @property {string} [origin] Origin header to set for the upload.
   * @property {string} [predefinedAcl] Apply a predefined set of access
   *     controls to this object.
   *
   *     Acceptable values are:
   *     - **`authenticatedRead`** - Object owner gets `OWNER` access, and
   *       `allAuthenticatedUsers` get `READER` access.
   *
   *     - **`bucketOwnerFullControl`** - Object owner gets `OWNER` access, and
   *       project team owners get `OWNER` access.
   *
   *     - **`bucketOwnerRead`** - Object owner gets `OWNER` access, and project
   *       team owners get `READER` access.
   *
   *     - **`private`** - Object owner gets `OWNER` access.
   *
   *     - **`projectPrivate`** - Object owner gets `OWNER` access, and project
   *       team members get access according to their roles.
   *
   *     - **`publicRead`** - Object owner gets `OWNER` access, and `allUsers`
   * get `READER` access.
   * @property {boolean} [private] Make the uploaded file private. (Alias for
   *     `options.predefinedAcl = 'private'`)
   * @property {boolean} [public] Make the uploaded file public. (Alias for
   *     `options.predefinedAcl = 'publicRead'`)
   * @property {string} [userProject] The ID of the project which will be
   *     billed for the request.
   */
  /**
   * Create a unique resumable upload session URI. This is the first step when
   * performing a resumable upload.
   *
   * See the [Resumable upload
   * guide](https://cloud.google.com/storage/docs/json_api/v1/how-tos/resumable-upload)
   * for more on how the entire process works.
   *
   * <h4>Note</h4>
   *
   * If you are just looking to perform a resumable upload without worrying
   * about any of the details, see {@link File#createWriteStream}. Resumable
   * uploads are performed by default.
   *
   * @see [Resumable upload guide]{@link https://cloud.google.com/storage/docs/json_api/v1/how-tos/resumable-upload}
   *
   * @param {CreateResumableUploadOptions} [options] Configuration options.
   * @param {CreateResumableUploadCallback} [callback] Callback function.
   * @returns {Promise<CreateResumableUploadResponse>}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   * file.createResumableUpload(function(err, uri) {
   *   if (!err) {
   *     // `uri` can be used to PUT data to.
   *   }
   * });
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.createResumableUpload().then(function(data) {
   *   const uri = data[0];
   * });
   */
  createResumableUpload(
    optionsOrCallback?:
      | CreateResumableUploadOptions
      | CreateResumableUploadCallback,
    callback?: CreateResumableUploadCallback
  ): void | Promise<CreateResumableUploadResponse> {
    const options =
      typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
    callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;

    resumableUpload.createURI(
      {
        authClient: this.storage.authClient,
        bucket: this.bucket.name,
        file: this.name,
        generation: this.generation,
        key: this.encryptionKey,
        kmsKeyName: this.kmsKeyName,
        metadata: options.metadata,
        offset: options.offset,
        origin: options.origin,
        predefinedAcl: options.predefinedAcl,
        private: options.private,
        public: options.public,
        userProject: options.userProject || this.userProject,
      },
      callback!
    );
  }

  /**
   * @typedef {object} CreateWriteStreamOptions Configuration options for File#createWriteStream().
   * @property {string} [contentType] Alias for
   *     `options.metadata.contentType`. If set to `auto`, the file name is used
   *     to determine the contentType.
   * @property {string|boolean} [gzip] If true, automatically gzip the file.
   *     If set to `auto`, the contentType is used to determine if the file
   * should be gzipped. This will set `options.metadata.contentEncoding` to
   * `gzip` if necessary.
   * @property {object} [metadata] See the examples below or
   *     [Objects: insert request
   * body](https://cloud.google.com/storage/docs/json_api/v1/objects/insert#request_properties_JSON)
   *     for more details.
   * @property {number} [offset] The starting byte of the upload stream, for
   *     resuming an interrupted upload. Defaults to 0.
   * @property {string} [predefinedAcl] Apply a predefined set of access
   *     controls to this object.
   *
   *     Acceptable values are:
   *     - **`authenticatedRead`** - Object owner gets `OWNER` access, and
   *       `allAuthenticatedUsers` get `READER` access.
   *
   *     - **`bucketOwnerFullControl`** - Object owner gets `OWNER` access, and
   *       project team owners get `OWNER` access.
   *
   *     - **`bucketOwnerRead`** - Object owner gets `OWNER` access, and project
   *       team owners get `READER` access.
   *
   *     - **`private`** - Object owner gets `OWNER` access.
   *
   *     - **`projectPrivate`** - Object owner gets `OWNER` access, and project
   *       team members get access according to their roles.
   *
   *     - **`publicRead`** - Object owner gets `OWNER` access, and `allUsers`
   * get `READER` access.
   * @property {boolean} [private] Make the uploaded file private. (Alias for
   *     `options.predefinedAcl = 'private'`)
   * @property {boolean} [public] Make the uploaded file public. (Alias for
   *     `options.predefinedAcl = 'publicRead'`)
   * @property {boolean} [resumable] Force a resumable upload. NOTE: When
   *     working with streams, the file format and size is unknown until it's
   *     completely consumed. Because of this, it's best for you to be explicit
   *     for what makes sense given your input.
   * @property {string} [uri] The URI for an already-created resumable
   *     upload. See {@link File#createResumableUpload}.
   * @property {string} [userProject] The ID of the project which will be
   *     billed for the request.
   * @property {string|boolean} [validation] Possible values: `"md5"`,
   *     `"crc32c"`, or `false`. By default, data integrity is validated with a
   *     CRC32c checksum. You may use MD5 if preferred, but that hash is not
   *     supported for composite objects. An error will be raised if MD5 is
   *     specified but is not available. You may also choose to skip validation
   *     completely, however this is **not recommended**.
   */
  /**
   * Create a writable stream to overwrite the contents of the file in your
   * bucket.
   *
   * A File object can also be used to create files for the first time.
   *
   * Resumable uploads are automatically enabled and must be shut off explicitly
   * by setting `options.resumable` to `false`.
   *
   * Resumable uploads require write access to the $HOME directory. Through
   * [`config-store`](http://www.gitnpm.com/configstore), some metadata is
   * stored. By default, if the directory is not writable, we will fall back to
   * a simple upload. However, if you explicitly request a resumable upload, and
   * we cannot write to the config directory, we will return a
   * `ResumableUploadError`.
   *
   * <p class="notice">
   *   There is some overhead when using a resumable upload that can cause
   *   noticeable performance degradation while uploading a series of small
   * files. When uploading files less than 10MB, it is recommended that the
   * resumable feature is disabled.
   * </p>
   *
   * For faster crc32c computation, you must manually install
   * [`fast-crc32c`](http://www.gitnpm.com/fast-crc32c):
   *
   *     $ npm install --save fast-crc32c
   *
   * NOTE: Writable streams will emit the `finish` event when the file is fully
   * uploaded.
   *
   * @see [Upload Options (Simple or Resumable)]{@link https://cloud.google.com/storage/docs/json_api/v1/how-tos/upload}
   * @see [Objects: insert API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/insert}
   *
   * @param {CreateWriteStreamOptions} [options] Configuration options.
   * @returns {WritableStream}
   *
   * @example
   * const fs = require('fs');
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   *
   * //-
   * // <h4>Uploading a File</h4>
   * //
   * // Now, consider a case where we want to upload a file to your bucket. You
   * // have the option of using {@link Bucket#upload}, but that is just
   * // a convenience method which will do the following.
   * //-
   * fs.createReadStream('/Users/stephen/Photos/birthday-at-the-zoo/panda.jpg')
   *   .pipe(file.createWriteStream())
   *   .on('error', function(err) {})
   *   .on('finish', function() {
   *     // The file upload is complete.
   *   });
   *
   * //-
   * // <h4>Uploading a File with gzip compression</h4>
   * //-
   * fs.createReadStream('/Users/stephen/site/index.html')
   *   .pipe(file.createWriteStream({ gzip: true }))
   *   .on('error', function(err) {})
   *   .on('finish', function() {
   *     // The file upload is complete.
   *   });
   *
   * //-
   * // Downloading the file with `createReadStream` will automatically decode
   * // the file.
   * //-
   *
   * //-
   * // <h4>Uploading a File with Metadata</h4>
   * //
   * // One last case you may run into is when you want to upload a file to your
   * // bucket and set its metadata at the same time. Like above, you can use
   * // {@link Bucket#upload} to do this, which is just a wrapper around
   * // the following.
   * //-
   * fs.createReadStream('/Users/stephen/Photos/birthday-at-the-zoo/panda.jpg')
   *   .pipe(file.createWriteStream({
   *     metadata: {
   *       contentType: 'image/jpeg',
   *       metadata: {
   *         custom: 'metadata'
   *       }
   *     }
   *   }))
   *   .on('error', function(err) {})
   *   .on('finish', function() {
   *     // The file upload is complete.
   *   });
   */
  // tslint:disable-next-line:no-any
  createWriteStream(options: CreateWriteStreamOptions = {}): Writable {
    options = Object.assign({metadata: {}}, options);

    if (options.contentType) {
      options.metadata.contentType = options.contentType;

      if (options.metadata.contentType === 'auto') {
        options.metadata.contentType = mime.getType(this.name);
      }
    }

    let gzip = options.gzip;

    if (gzip === 'auto') {
      gzip = compressible(options.metadata.contentType);
    }

    if (gzip) {
      options.metadata.contentEncoding = 'gzip';
    }

    let crc32c = true;
    let md5 = false;

    if (typeof options.validation === 'string') {
      options.validation = options.validation.toLowerCase();
      crc32c = options.validation === 'crc32c';
      md5 = options.validation === 'md5';
    } else if (options.validation === false) {
      crc32c = false;
    }

    // Collect data as it comes in to store in a hash. This is compared to the
    // checksum value on the returned metadata from the API.
    const validateStream = hashStreamValidation({
      crc32c,
      md5,
    });

    const fileWriteStream = duplexify();

    const stream = streamEvents(
      pumpify([
        gzip ? zlib.createGzip() : through(),
        validateStream,
        fileWriteStream,
      ])
    ) as Duplex;

    // Wait until we've received data to determine what upload technique to use.
    stream.on('writing', () => {
      if (options.resumable === false) {
        this.startSimpleUpload_(fileWriteStream, options);
        return;
      }

      // Same as configstore:
      // https://github.com/yeoman/configstore/blob/f09f067e50e6a636cfc648a6fc36a522062bd49d/index.js#L11
      const configDir = xdgBasedir.config || os.tmpdir();

      fs.access(configDir, fs.constants.W_OK, err => {
        if (err) {
          if (options.resumable) {
            const error = new ResumableUploadError(
              [
                'A resumable upload could not be performed. The directory,',
                `${configDir}, is not writable. You may try another upload,`,
                'this time setting `options.resumable` to `false`.',
              ].join(' ')
            );
            stream.destroy(error);
            return;
          }

          // User didn't care, resumable or not. Fall back to simple upload.
          this.startSimpleUpload_(fileWriteStream, options);
          return;
        }

        this.startResumableUpload_(fileWriteStream, options);
      });
    });

    fileWriteStream.on('response', stream.emit.bind(stream, 'response'));

    // This is to preserve the `finish` event. We wait until the request stream
    // emits "complete", as that is when we do validation of the data. After
    // that is successful, we can allow the stream to naturally finish.
    //
    // Reference for tracking when we can use a non-hack solution:
    // https://github.com/nodejs/node/pull/2314
    fileWriteStream.on('prefinish', () => {
      stream.cork();
    });

    // Compare our hashed version vs the completed upload's version.
    fileWriteStream.on('complete', () => {
      const metadata = this.metadata;

      // If we're doing validation, assume the worst-- a data integrity
      // mismatch. If not, these tests won't be performed, and we can assume the
      // best.
      let failed = crc32c || md5;

      if (crc32c && metadata.crc32c) {
        // We must remove the first four bytes from the returned checksum.
        // http://stackoverflow.com/questions/25096737/
        //   base64-encoding-of-crc32c-long-value
        failed = !validateStream.test('crc32c', metadata.crc32c.substr(4));
      }

      if (md5 && metadata.md5Hash) {
        failed = !validateStream.test('md5', metadata.md5Hash);
      }

      if (failed) {
        this.delete((err: ApiError) => {
          let code;
          let message;

          if (err) {
            code = 'FILE_NO_UPLOAD_DELETE';
            message = [
              'The uploaded data did not match the data from the server. As a',
              'precaution, we attempted to delete the file, but it was not',
              'successful. To be sure the content is the same, you should try',
              'removing the file manually, then uploading the file again.',
              '\n\nThe delete attempt failed with this message:',
              '\n\n  ' + err.message,
            ].join(' ');
          } else if (md5 && !metadata.md5Hash) {
            code = 'MD5_NOT_AVAILABLE';
            message = [
              'MD5 verification was specified, but is not available for the',
              'requested object. MD5 is not available for composite objects.',
            ].join(' ');
          } else {
            code = 'FILE_NO_UPLOAD';
            message = [
              'The uploaded data did not match the data from the server. As a',
              'precaution, the file has been deleted. To be sure the content',
              'is the same, you should try uploading the file again.',
            ].join(' ');
          }

          const error = new RequestError(message);
          error.code = code;
          error.errors = [err!];

          fileWriteStream.destroy(error);
        });

        return;
      }

      stream.uncork();
    });

    return stream as Writable;
  }

  download(options?: DownloadOptions): Promise<DownloadResponse>;
  download(options: DownloadOptions, callback: DownloadCallback): void;
  download(callback: DownloadCallback): void;
  /**
   * @typedef {array} DownloadResponse
   * @property [0] The contents of a File.
   */
  /**
   * @callback DownloadCallback
   * @param err Request error, if any.
   * @param contents The contents of a File.
   */
  /**
   * Convenience method to download a file into memory or to a local
   * destination.
   *
   * @param {object} [options] Configuration options. The arguments match those
   *     passed to {@link File#createReadStream}.
   * @param {string} [options.destination] Local file path to write the file's
   *     contents to.
   * @param {string} [options.userProject] The ID of the project which will be
   *     billed for the request.
   * @param {DownloadCallback} [callback] Callback function.
   * @returns {Promise<DownloadResponse>}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   *
   * //-
   * // Download a file into memory. The contents will be available as the
   * second
   * // argument in the demonstration below, `contents`.
   * //-
   * file.download(function(err, contents) {});
   *
   * //-
   * // Download a file to a local destination.
   * //-
   * file.download({
   *   destination: '/Users/me/Desktop/file-backup.txt'
   * }, function(err) {});
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.download().then(function(data) {
   *   const contents = data[0];
   * });
   *
   * @example <caption>include:samples/files.js</caption>
   * region_tag:storage_download_file
   * Another example:
   *
   * @example <caption>include:samples/encryption.js</caption>
   * region_tag:storage_download_encrypted_file
   * Example of downloading an encrypted file:
   *
   * @example <caption>include:samples/requesterPays.js</caption>
   * region_tag:storage_download_file_requester_pays
   * Example of downloading a file where the requester pays:
   */
  download(
    optionsOrCallback?: DownloadOptions | DownloadCallback,
    callback?: DownloadCallback
  ): Promise<DownloadResponse> | void {
    let options: DownloadOptions;
    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback as DownloadCallback;
      options = {};
    } else {
      options = optionsOrCallback as DownloadOptions;
    }

    callback = once(callback as DownloadCallback);

    const destination = options.destination;
    delete options.destination;

    const fileStream = this.createReadStream(options);

    if (destination) {
      fileStream
        .on('error', callback)
        .pipe(fs.createWriteStream(destination))
        .on('error', callback)
        .on('finish', callback);
    } else {
      fileStream.on('error', callback).pipe(concat(callback.bind(null, null)));
    }
  }

  /**
   * The Storage API allows you to use a custom key for server-side encryption.
   *
   * @see [Customer-supplied Encryption Keys]{@link https://cloud.google.com/storage/docs/encryption#customer-supplied}
   *
   * @param {string|buffer} encryptionKey An AES-256 encryption key.
   * @returns {File}
   *
   * @example
   * const crypto = require('crypto');
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const encryptionKey = crypto.randomBytes(32);
   *
   * const fileWithCustomEncryption = myBucket.file('my-file');
   * fileWithCustomEncryption.setEncryptionKey(encryptionKey);
   *
   * const fileWithoutCustomEncryption = myBucket.file('my-file');
   *
   * fileWithCustomEncryption.save('data', function(err) {
   *   // Try to download with the File object that hasn't had
   *   // `setEncryptionKey()` called:
   *   fileWithoutCustomEncryption.download(function(err) {
   *     // We will receive an error:
   *     //   err.message === 'Bad Request'
   *
   *     // Try again with the File object we called `setEncryptionKey()` on:
   *     fileWithCustomEncryption.download(function(err, contents) {
   *       // contents.toString() === 'data'
   *     });
   *   });
   * });
   *
   * @example <caption>include:samples/encryption.js</caption>
   * region_tag:storage_upload_encrypted_file
   * Example of uploading an encrypted file:
   *
   * @example <caption>include:samples/encryption.js</caption>
   * region_tag:storage_download_encrypted_file
   * Example of downloading an encrypted file:
   */
  setEncryptionKey(encryptionKey: string | Buffer) {
    this.encryptionKey = encryptionKey;
    this.encryptionKeyBase64 = Buffer.from(encryptionKey as string).toString(
      'base64'
    );
    this.encryptionKeyHash = crypto
      .createHash('sha256')
      // tslint:disable-next-line:no-any
      .update(this.encryptionKeyBase64, 'base64' as any)
      .digest('base64');

    this.encryptionKeyInterceptor = {
      request: reqOpts => {
        reqOpts.headers = reqOpts.headers || {};
        reqOpts.headers['x-goog-encryption-algorithm'] = 'AES256';
        reqOpts.headers['x-goog-encryption-key'] = this.encryptionKeyBase64;
        reqOpts.headers[
          'x-goog-encryption-key-sha256'
        ] = this.encryptionKeyHash;
        return reqOpts as DecorateRequestOptions;
      },
    };

    this.interceptors.push(this.encryptionKeyInterceptor!);

    return this;
  }

  getExpirationDate(): Promise<GetExpirationDateResponse>;
  getExpirationDate(callback: GetExpirationDateCallback): void;
  /**
   * @typedef {array} GetExpirationDateResponse
   * @property {date} 0 A Date object representing the earliest time this file's
   *     retention policy will expire.
   */
  /**
   * @callback GetExpirationDateCallback
   * @param {?Error} err Request error, if any.
   * @param {date} expirationDate A Date object representing the earliest time
   *     this file's retention policy will expire.
   */
  /**
   * If this bucket has a retention policy defined, use this method to get a
   * Date object representing the earliest time this file will expire.
   *
   * @param {GetExpirationDateCallback} [callback] Callback function.
   * @returns {Promise<GetExpirationDateResponse>}
   *
   * @example
   * const storage = require('@google-cloud/storage')();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   *
   * file.getExpirationDate(function(err, expirationDate) {
   *   // expirationDate is a Date object.
   * });
   */
  getExpirationDate(
    callback?: GetExpirationDateCallback
  ): void | Promise<GetExpirationDateResponse> {
    this.getMetadata(
      (err: ApiError | null, metadata: Metadata, apiResponse: Metadata) => {
        if (err) {
          callback!(err, null, apiResponse);
          return;
        }

        if (!metadata.retentionExpirationTime) {
          const error = new Error('An expiration time is not available.');
          callback!(error, null, apiResponse);
          return;
        }

        callback!(
          null,
          new Date(metadata.retentionExpirationTime),
          apiResponse
        );
      }
    );
  }

  getSignedPolicy(
    options: GetSignedPolicyOptions
  ): Promise<GetSignedPolicyResponse>;
  getSignedPolicy(
    options: GetSignedPolicyOptions,
    callback: GetSignedPolicyCallback
  ): void;
  getSignedPolicy(callback: GetSignedPolicyCallback): void;
  /**
   * @typedef {array} GetSignedPolicyResponse
   * @property {object} 0 The document policy.
   */
  /**
   * @callback GetSignedPolicyCallback
   * @param {?Error} err Request error, if any.
   * @param {object} policy The document policy.
   */
  /**
   * Get a signed policy document to allow a user to upload data with a POST
   * request.
   *
   * In Google Cloud Platform environments, such as Cloud Functions and App
   * Engine, you usually don't provide a `keyFilename` or `credentials` during
   * instantiation. In those environments, we call the
   * [signBlob
   * API](https://cloud.google.com/iam/reference/rest/v1/projects.serviceAccounts/signBlob#authorization-scopes)
   * to create a signed policy. That API requires either the
   * `https://www.googleapis.com/auth/iam` or
   * `https://www.googleapis.com/auth/cloud-platform` scope, so be sure they are
   * enabled.
   *
   * @see [Policy Document Reference]{@link https://cloud.google.com/storage/docs/xml-api/post-object#policydocument}
   *
   * @throws {Error} If an expiration timestamp from the past is given.
   * @throws {Error} If options.equals has an array with less or more than two
   *     members.
   * @throws {Error} If options.startsWith has an array with less or more than two
   *     members.
   *
   * @param {object} options Configuration options.
   * @param {array|array[]} [options.equals] Array of request parameters and
   *     their expected value (e.g. [['$<field>', '<value>']]). Values are
   *     translated into equality constraints in the conditions field of the
   *     policy document (e.g. ['eq', '$<field>', '<value>']). If only one
   *     equality condition is to be specified, options.equals can be a one-
   *     dimensional array (e.g. ['$<field>', '<value>']).
   * @param {*} options.expires - A timestamp when this policy will expire. Any
   *     value given is passed to `new Date()`.
   * @param {array|array[]} [options.startsWith] Array of request parameters and
   *     their expected prefixes (e.g. [['$<field>', '<value>']). Values are
   *     translated into starts-with constraints in the conditions field of the
   *     policy document (e.g. ['starts-with', '$<field>', '<value>']). If only
   *     one prefix condition is to be specified, options.startsWith can be a
   * one- dimensional array (e.g. ['$<field>', '<value>']).
   * @param {string} [options.acl] ACL for the object from possibly predefined
   *     ACLs.
   * @param {string} [options.successRedirect] The URL to which the user client
   *     is redirected if the upload is successful.
   * @param {string} [options.successStatus] - The status of the Google Storage
   *     response if the upload is successful (must be string).
   * @param {object} [options.contentLengthRange]
   * @param {number} [options.contentLengthRange.min] Minimum value for the
   *     request's content length.
   * @param {number} [options.contentLengthRange.max] Maximum value for the
   *     request's content length.
   * @param {GetSignedPolicyCallback} [callback] Callback function.
   * @returns {Promise<GetSignedPolicyResponse>}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   * const options = {
   *   equals: ['$Content-Type', 'image/jpeg'],
   *   expires: '10-25-2022',
   *   contentLengthRange: {
   *     min: 0,
   *     max: 1024
   *   }
   * };
   *
   * file.getSignedPolicy(options, function(err, policy) {
   *   // policy.string: the policy document in plain text.
   *   // policy.base64: the policy document in base64.
   *   // policy.signature: the policy signature in base64.
   * });
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.getSignedPolicy(options).then(function(data) {
   *   const policy = data[0];
   * });
   */
  getSignedPolicy(
    optionsOrCallback?: GetSignedPolicyOptions | GetSignedPolicyCallback,
    cb?: GetSignedPolicyCallback
  ): void | Promise<GetSignedPolicyResponse> {
    const args = normalize<GetSignedPolicyOptions>(optionsOrCallback, cb);
    let options = args.options;
    const callback = args.callback;
    const expires = new Date((options as GetSignedPolicyOptions).expires);

    if (isNaN(expires.getTime())) {
      throw new Error('The expiration date provided was invalid.');
    }

    if (expires.valueOf() < Date.now()) {
      throw new Error('An expiration date cannot be in the past.');
    }

    options = Object.assign({}, options);

    const conditions = [
      ['eq', '$key', this.name],
      {
        bucket: this.bucket.name,
      },
    ] as object[];

    if (Array.isArray(options.equals)) {
      if (!Array.isArray((options.equals as string[][])[0])) {
        options.equals = [options.equals as string[]];
      }
      (options.equals as string[][]).forEach(condition => {
        if (!Array.isArray(condition) || condition.length !== 2) {
          throw new Error('Equals condition must be an array of 2 elements.');
        }
        conditions.push(['eq', condition[0], condition[1]]);
      });
    }

    if (Array.isArray(options.startsWith)) {
      if (!Array.isArray((options.startsWith as string[][])[0])) {
        options.startsWith = [options.startsWith as string[]];
      }
      (options.startsWith as string[][]).forEach(condition => {
        if (!Array.isArray(condition) || condition.length !== 2) {
          throw new Error(
            'StartsWith condition must be an array of 2 elements.'
          );
        }
        conditions.push(['starts-with', condition[0], condition[1]]);
      });
    }

    if (options.acl) {
      conditions.push({
        acl: options.acl,
      });
    }

    if (options.successRedirect) {
      conditions.push({
        success_action_redirect: options.successRedirect,
      });
    }

    if (options.successStatus) {
      conditions.push({
        success_action_status: options.successStatus,
      });
    }

    if (options.contentLengthRange) {
      const min = options.contentLengthRange.min;
      const max = options.contentLengthRange.max;
      if (typeof min !== 'number' || typeof max !== 'number') {
        throw new Error(
          'ContentLengthRange must have numeric min & max fields.'
        );
      }
      conditions.push(['content-length-range', min, max]);
    }

    const policy = {
      expiration: expires.toISOString(),
      conditions,
    };

    const policyString = JSON.stringify(policy);
    const policyBase64 = Buffer.from(policyString).toString('base64');

    this.storage.authClient.sign(policyBase64).then(
      signature => {
        callback(null, {
          string: policyString,
          base64: policyBase64,
          signature,
        });
      },
      err => {
        callback(new SigningError(err.message));
      }
    );
  }

  getSignedUrl(cfg: GetSignedUrlConfig): Promise<GetSignedUrlResponse>;
  getSignedUrl(cfg: GetSignedUrlConfig, callback: GetSignedUrlCallback): void;
  /**
   * @typedef {array} GetSignedUrlResponse
   * @property {object} 0 The signed URL.
   */
  /**
   * @callback GetSignedUrlCallback
   * @param {?Error} err Request error, if any.
   * @param {object} url The signed URL.
   */
  /**
   * Get a signed URL to allow limited time access to the file.
   *
   * In Google Cloud Platform environments, such as Cloud Functions and App
   * Engine, you usually don't provide a `keyFilename` or `credentials` during
   * instantiation. In those environments, we call the
   * [signBlob
   * API](https://cloud.google.com/iam/reference/rest/v1/projects.serviceAccounts/signBlob#authorization-scopes)
   * to create a signed URL. That API requires either the
   * `https://www.googleapis.com/auth/iam` or
   * `https://www.googleapis.com/auth/cloud-platform` scope, so be sure they are
   * enabled.
   *
   * @see [Signed URLs Reference]{@link https://cloud.google.com/storage/docs/access-control/signed-urls}
   *
   * @throws {Error} if an expiration timestamp from the past is given.
   *
   * @param {object} config Configuration object.
   * @param {string} config.action "read" (HTTP: GET), "write" (HTTP: PUT), or
   *     "delete" (HTTP: DELETE), "resumable" (HTTP: POST).
   *     When using "resumable", the header `X-Goog-Resumable: start` has
   *     to be sent when making a request with the signed URL.
   * @param {string} [config.version='v2'] The signing version to use, either
   *     'v2' or 'v4.
   * @param {string} [config.cname] The cname for this bucket, i.e.,
   *     "https://cdn.example.com".
   * @param {string} [config.contentMd5] The MD5 digest value in base64. If you
   *     provide this, the client must provide this HTTP header with this same
   *     value in its request.
   * @param {string} [config.contentType] If you provide this value, the client
   *     must provide this HTTP header set to the same value.
   * @param {*} config.expires A timestamp when this link will expire. Any value
   *     given is passed to `new Date()`.
   * @param {object} [config.extensionHeaders] If these headers are used, the
   *     server will check to make sure that the client provides matching
   * values. See [Canonical extension
   * headers](https://cloud.google.com/storage/docs/access-control/signed-urls#about-canonical-extension-headers)
   *     for the requirements of this feature, most notably:
   *       - The header name must be prefixed with `x-goog-`
   *       - The header name must be all lowercase
   *     Note: Multi-valued header passed as an array in the extensionHeaders
   *           object is converted into a string, delimited by `,` with
   *           no space. Requests made using the signed URL will need to
   *           delimit multi-valued headers using a single `,` as well, or
   *           else the server will report a mismatched signature.
   * @param {string} [config.promptSaveAs] The filename to prompt the user to
   *     save the file as when the signed url is accessed. This is ignored if
   *     `config.responseDisposition` is set.
   * @param {string} [config.responseDisposition] The
   *     [response-content-disposition parameter](http://goo.gl/yMWxQV) of the
   *     signed url.
   * @param {string} [config.responseType] The response-content-type parameter
   *     of the signed url.
   * @param {GetSignedUrlCallback} [callback] Callback function.
   * @returns {Promise<GetSignedUrlResponse>}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   *
   * //-
   * // Generate a URL that allows temporary access to download your file.
   * //-
   * const request = require('request');
   *
   * const config = {
   *   action: 'read',
   *   expires: '03-17-2025'
   * };
   *
   * file.getSignedUrl(config, function(err, url) {
   *   if (err) {
   *     console.error(err);
   *     return;
   *   }
   *
   *   // The file is now available to read from this URL.
   *   request(url, function(err, resp) {
   *     // resp.statusCode = 200
   *   });
   * });
   *
   * //-
   * // Generate a URL to allow write permissions. This means anyone with this
   * URL
   * // can send a POST request with new data that will overwrite the file.
   * //-
   * file.getSignedUrl({
   *   action: 'write',
   *   expires: '03-17-2025'
   * }, function(err, url) {
   *   if (err) {
   *     console.error(err);
   *     return;
   *   }
   *
   *   // The file is now available to be written to.
   *   const writeStream = request.put(url);
   *   writeStream.end('New data');
   *
   *   writeStream.on('complete', function(resp) {
   *     // Confirm the new content was saved.
   *     file.download(function(err, fileContents) {
   *       console.log('Contents:', fileContents.toString());
   *       // Contents: New data
   *     });
   *   });
   * });
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.getSignedUrl(config).then(function(data) {
   *   const url = data[0];
   * });
   *
   * @example <caption>include:samples/files.js</caption>
   * region_tag:storage_generate_signed_url
   * Another example:
   */
  getSignedUrl(
    cfg: GetSignedUrlConfig,
    callback?: GetSignedUrlCallback
  ): void | Promise<GetSignedUrlResponse> {
    const expiresInMSeconds = new Date(cfg.expires).valueOf();

    if (isNaN(expiresInMSeconds)) {
      throw new Error('The expiration date provided was invalid.');
    }

    if (expiresInMSeconds < Date.now()) {
      throw new Error('An expiration date cannot be in the past.');
    }

    const expiresInSeconds = Math.round(expiresInMSeconds / 1000); // The API expects seconds.

    const method = ActionToHTTPMethod[cfg.action];

    if (!method) {
      throw new Error('The action is not provided or invalid.');
    }

    const name = encodeURIComponent(this.name);
    const resource = `/${this.bucket.name}/${name}`;

    const version = cfg.version || DEFAULT_SIGNING_VERSION;

    const config: GetSignedUrlConfigInternal = Object.assign({}, cfg, {
      method,
      expiration: expiresInSeconds,
      resource,
      name,
    });

    let promise: Promise<SignedUrlQuery>;
    if (version === 'v2') {
      promise = this.getSignedUrlV2(config);
    } else if (version === 'v4') {
      promise = this.getSignedUrlV4(config);
    } else {
      throw new Error(
        `Invalid signed URL version: ${version}. Supported versions are 'v2' and 'v4'.`
      );
    }

    promise.then(query => {
      if (typeof config.responseType === 'string') {
        query['response-content-type'] = config.responseType!;
      }

      if (typeof config.promptSaveAs === 'string') {
        query['response-content-disposition'] =
          'attachment; filename="' + config.promptSaveAs + '"';
      }
      if (typeof config.responseDisposition === 'string') {
        query['response-content-disposition'] = config.responseDisposition!;
      }

      if (this.generation) {
        query.generation = this.generation;
      }

      const signedUrl = new url.URL(config.cname || STORAGE_DOWNLOAD_BASE_URL);
      signedUrl.pathname = config.cname ? name : `${this.bucket.name}/${name}`;
      // tslint:disable-next-line:no-any
      signedUrl.search = querystring.stringify(query as any);

      callback!(null, signedUrl.href);
    }, callback!);
  }

  private getSignedUrlV2(
    config: GetSignedUrlConfigInternal
  ): Promise<SignedUrlQuery> {
    let extensionHeadersString = '';

    if (config.method === 'POST') {
      config.extensionHeaders = Object.assign({}, config.extensionHeaders, {
        'x-goog-resumable': 'start',
      });
    }

    if (config.extensionHeaders) {
      for (const headerName of Object.keys(config.extensionHeaders)) {
        extensionHeadersString += `${headerName}:${config.extensionHeaders[headerName]}\n`;
      }
    }

    const blobToSign = [
      config.method,
      config.contentMd5 || '',
      config.contentType || '',
      config.expiration,
      extensionHeadersString + config.resource,
    ].join('\n');

    const authClient = this.storage.authClient;
    return authClient
      .sign(blobToSign)
      .then(signature =>
        authClient.getCredentials().then(
          credentials =>
            ({
              GoogleAccessId: credentials.client_email!,
              Expires: config.expiration,
              Signature: signature,
            } as V2SignedUrlQuery)
        )
      )
      .catch(err => {
        const signingErr = new SigningError(err.message);
        signingErr.stack = err.stack;
        throw signingErr;
      });
  }

  private getSignedUrlV4(
    config: GetSignedUrlConfigInternal
  ): Promise<SignedUrlQuery> {
    const now = new Date();
    const nowInSeconds = Math.floor(now.valueOf() / 1000);
    const expiresPeriodInSeconds = config.expiration - nowInSeconds;

    // v4 limit expiration to be 7 days maximum
    if (expiresPeriodInSeconds > SEVEN_DAYS) {
      throw new Error(
        `Max allowed expiration is seven days (${SEVEN_DAYS} seconds).`
      );
    }

    const extensionHeaders = Object.assign({}, config.extensionHeaders);
    extensionHeaders.host = 'storage.googleapis.com';
    if (config.method === 'POST') {
      extensionHeaders['x-goog-resumable'] = 'start';
    }
    if (config.contentMd5) {
      extensionHeaders['content-md5'] = config.contentMd5;
    }
    if (config.contentType) {
      extensionHeaders['content-type'] = config.contentType;
    }

    const signedHeaders = Object.keys(extensionHeaders)
      .map(header => header.toLowerCase())
      .sort()
      .join(';');

    const extensionHeadersString = this.getCanonicalHeaders(extensionHeaders);

    const datestamp = dateFormat.format(now, 'YYYYMMDD', true);
    const credentialScope = `${datestamp}/auto/storage/goog4_request`;

    return this.storage.authClient.getCredentials().then(credentials => {
      const credential = `${credentials.client_email}/${credentialScope}`;
      const dateISO = dateFormat.format(now, 'YYYYMMDD[T]HHmmss[Z]', true);

      const queryParams: V4UrlQuery = {
        'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
        'X-Goog-Credential': credential,
        'X-Goog-Date': dateISO,
        'X-Goog-Expires': expiresPeriodInSeconds,
        'X-Goog-SignedHeaders': signedHeaders,
      };

      // tslint:disable-next-line:no-any
      const canonicalQueryParams = querystring.stringify(queryParams as any);

      const canonicalRequest = [
        config.method,
        config.resource,
        canonicalQueryParams,
        extensionHeadersString,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
      ].join('\n');

      const canonicalRequestHash = crypto
        .createHash('sha256')
        .update(canonicalRequest)
        .digest('hex');

      const blobToSign = [
        'GOOG4-RSA-SHA256',
        dateISO,
        credentialScope,
        canonicalRequestHash,
      ].join('\n');

      return this.storage.authClient
        .sign(blobToSign)
        .then(signature => {
          const signatureHex = Buffer.from(signature, 'base64').toString('hex');

          const signedQuery: V4SignedUrlQuery = Object.assign({}, queryParams, {
            'X-Goog-Signature': signatureHex,
          });

          return signedQuery;
        })
        .catch(err => {
          const signingErr = new SigningError(err.message);
          signingErr.stack = err.stack;
          throw signingErr;
        });
    });
  }

  isPublic(): Promise<IsPublicResponse>;
  isPublic(callback: IsPublicCallback): void;
  /**
   * @callback IsPublicCallback
   * @param {?Error} err Request error, if any.
   * @param {boolean} resp Whether file is public or not.
   */
  /**
   * @typedef {array} IsPublicResponse
   * @property {boolean} 0 Whether file is public or not.
   */
  /**
   * Check whether this file is public or not by sending
   * a HEAD request without credentials.
   * No errors from the server indicates that the current
   * file is public.
   * A 403-Forbidden error {@link https://cloud.google.com/storage/docs/json_api/v1/status-codes#403_Forbidden}
   * indicates that file is private.
   * Any other non 403 error is propagated to user.
   *
   * @param {IsPublicCallback} [callback] Callback function.
   * @returns {Promise<IsPublicResponse>}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   *
   * //-
   * // Check whether the file is publicly accessible.
   * //-
   * file.isPublic(function(err, resp) {
   *   if (err) {
   *     console.error(err);
   *     return;
   *   }
   *   console.log(`the file ${file.id} is public: ${resp}`) ;
   * })
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.isPublic().then(function(data) {
   *   const resp = data[0];
   * });
   */

  isPublic(callback?: IsPublicCallback): Promise<IsPublicResponse> | void {
    gaxiosRequest({
      method: 'HEAD',
      url: `http://${
        this.bucket.name
      }.storage.googleapis.com/${encodeURIComponent(this.name)}`,
    }).then(
      () => callback!(null, true),
      (err: GaxiosError) => {
        if (err.code === '403') {
          callback!(null, false);
        } else {
          callback!(err);
        }
      }
    );
  }

  makePrivate(
    options?: MakeFilePrivateOptions
  ): Promise<MakeFilePrivateResponse>;
  makePrivate(callback: MakeFilePrivateCallback): void;
  makePrivate(
    options: MakeFilePrivateOptions,
    callback: MakeFilePrivateCallback
  ): void;
  /**
   * @typedef {object} MakeFilePrivateOptions Configuration options for File#makePrivate().
   * @property {boolean} [strict] If true, set the file to be private to
   *     only the owner user. Otherwise, it will be private to the project.
   * @property {string} [userProject] The ID of the project which will be
   *     billed for the request.
   */
  /**
   * @callback MakeFilePrivateCallback
   * @param {?Error} err Request error, if any.
   * @param {object} apiResponse The full API response.
   */
  /**
   * @typedef {array} MakeFilePrivateResponse
   * @property {object} 0 The full API response.
   */
  /**
   * Make a file private to the project and remove all other permissions.
   * Set `options.strict` to true to make the file private to only the owner.
   *
   * @see [Objects: patch API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/patch}
   *
   * @param {MakeFilePrivateOptions} [options] Configuration options.
   * @param {MakeFilePrivateCallback} [callback] Callback function.
   * @returns {Promise<MakeFilePrivateResponse>}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   *
   * //-
   * // Set the file private so only project maintainers can see and modify it.
   * //-
   * file.makePrivate(function(err) {});
   *
   * //-
   * // Set the file private so only the owner can see and modify it.
   * //-
   * file.makePrivate({ strict: true }, function(err) {});
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.makePrivate().then(function(data) {
   *   const apiResponse = data[0];
   * });
   */
  makePrivate(
    optionsOrCallback?: MakeFilePrivateOptions | MakeFilePrivateCallback,
    callback?: MakeFilePrivateCallback
  ): Promise<MakeFilePrivateResponse> | void {
    const options =
      typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
    callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;

    const query = {
      predefinedAcl: options.strict ? 'private' : 'projectPrivate',
      // tslint:disable-next-line:no-any
    } as any;

    if (options.userProject) {
      query.userProject = options.userProject;
    }

    this.setMetadata(
      {
        // You aren't allowed to set both predefinedAcl & acl properties on a
        // file, so acl must explicitly be nullified, destroying all previous
        // acls on the file.
        acl: null,
      },
      query,
      callback!
    );
  }

  makePublic(): Promise<MakeFilePublicResponse>;
  makePublic(callback: MakeFilePublicCallback): void;
  /**
   * @typedef {array} MakeFilePublicResponse
   * @property {object} 0 The full API response.
   */
  /**
   * @callback MakeFilePublicCallback
   * @param {?Error} err Request error, if any.
   * @param {object} apiResponse The full API response.
   */
  /**
   * Set a file to be publicly readable and maintain all previous permissions.
   *
   * @see [ObjectAccessControls: insert API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objectAccessControls/insert}
   *
   * @param {MakeFilePublicCallback} [callback] Callback function.
   * @returns {Promise<MakeFilePublicResponse>}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   *
   * file.makePublic(function(err, apiResponse) {});
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.makePublic().then(function(data) {
   *   const apiResponse = data[0];
   * });
   *
   * @example <caption>include:samples/files.js</caption>
   * region_tag:storage_make_public
   * Another example:
   */
  makePublic(
    callback?: MakeFilePublicCallback
  ): Promise<MakeFilePublicResponse> | void {
    callback = callback || util.noop;
    this.acl.add(
      {
        entity: 'allUsers',
        role: 'READER',
      },
      (err, acl, resp) => {
        callback!(err, resp);
      }
    );
  }

  move(
    destination: string | Bucket | File,
    options?: MoveOptions
  ): Promise<MoveResponse>;
  move(destination: string | Bucket | File, callback: MoveCallback): void;
  move(
    destination: string | Bucket | File,
    options: MoveOptions,
    callback: MoveCallback
  ): void;
  /**
   * @typedef {array} MoveResponse
   * @property {File} 0 The destination File.
   * @property {object} 1 The full API response.
   */
  /**
   * @callback MoveCallback
   * @param {?Error} err Request error, if any.
   * @param {?File} destinationFile The destination File.
   * @param {object} apiResponse The full API response.
   */
  /**
   * @typedef {object} MoveOptions Configuration options for File#move(). See an
   *     [Object
   * resource](https://cloud.google.com/storage/docs/json_api/v1/objects#resource).
   * @param {string} [userProject] The ID of the project which will be
   *     billed for the request.
   */
  /**
   * Move this file to another location. By default, this will rename the file
   * and keep it in the same bucket, but you can choose to move it to another
   * Bucket by providing a Bucket or File object or a URL beginning with
   * "gs://".
   *
   * **Warning**:
   * There is currently no atomic `move` method in the Cloud Storage API,
   * so this method is a composition of {@link File#copy} (to the new
   * location) and {@link File#delete} (from the old location). While
   * unlikely, it is possible that an error returned to your callback could be
   * triggered from either one of these API calls failing, which could leave a
   * duplicate file lingering.
   *
   * @see [Objects: copy API Documentation]{@link https://cloud.google.com/storage/docs/json_api/v1/objects/copy}
   *
   * @throws {Error} If the destination file is not provided.
   *
   * @param {string|Bucket|File} destination Destination file.
   * @param {MoveCallback} [callback] Callback function.
   * @returns {Promise<MoveResponse>}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * //-
   * // You can pass in a variety of types for the destination.
   * //
   * // For all of the below examples, assume we are working with the following
   * // Bucket and File objects.
   * //-
   * const bucket = storage.bucket('my-bucket');
   * const file = bucket.file('my-image.png');
   *
   * //-
   * // If you pass in a string for the destination, the file is moved to its
   * // current bucket, under the new name provided.
   * //-
   * file.move('my-image-new.png', function(err, destinationFile, apiResponse) {
   *   // `my-bucket` no longer contains:
   *   // - "my-image.png"
   *   // but contains instead:
   *   // - "my-image-new.png"
   *
   *   // `destinationFile` is an instance of a File object that refers to your
   *   // new file.
   * });
   *
   * //-
   * // If you pass in a string starting with "gs://" for the destination, the
   * // file is copied to the other bucket and under the new name provided.
   * //-
   * const newLocation = 'gs://another-bucket/my-image-new.png';
   * file.move(newLocation, function(err, destinationFile, apiResponse) {
   *   // `my-bucket` no longer contains:
   *   // - "my-image.png"
   *   //
   *   // `another-bucket` now contains:
   *   // - "my-image-new.png"
   *
   *   // `destinationFile` is an instance of a File object that refers to your
   *   // new file.
   * });
   *
   * //-
   * // If you pass in a Bucket object, the file will be moved to that bucket
   * // using the same name.
   * //-
   * const anotherBucket = gcs.bucket('another-bucket');
   *
   * file.move(anotherBucket, function(err, destinationFile, apiResponse) {
   *   // `my-bucket` no longer contains:
   *   // - "my-image.png"
   *   //
   *   // `another-bucket` now contains:
   *   // - "my-image.png"
   *
   *   // `destinationFile` is an instance of a File object that refers to your
   *   // new file.
   * });
   *
   * //-
   * // If you pass in a File object, you have complete control over the new
   * // bucket and filename.
   * //-
   * const anotherFile = anotherBucket.file('my-awesome-image.png');
   *
   * file.move(anotherFile, function(err, destinationFile, apiResponse) {
   *   // `my-bucket` no longer contains:
   *   // - "my-image.png"
   *   //
   *   // `another-bucket` now contains:
   *   // - "my-awesome-image.png"
   *
   *   // Note:
   *   // The `destinationFile` parameter is equal to `anotherFile`.
   * });
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.move('my-image-new.png').then(function(data) {
   *   const destinationFile = data[0];
   *   const apiResponse = data[1];
   * });
   *
   * @example <caption>include:samples/files.js</caption>
   * region_tag:storage_move_file
   * Another example:
   */
  move(
    destination: string | Bucket | File,
    optionsOrCallback?: MoveOptions | MoveCallback,
    callback?: MoveCallback
  ): Promise<MoveResponse> | void {
    const options =
      typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
    callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;

    callback = callback || util.noop;

    this.copy(destination, options, (err, destinationFile, apiResponse) => {
      if (err) {
        callback!(err, null, apiResponse);
        return;
      }

      this.delete(options, (err, apiResponse) => {
        callback!(err, destinationFile, apiResponse);
      });
    });
  }

  request(reqOpts: DecorateRequestOptions): Promise<[ResponseBody, Metadata]>;
  request(
    reqOpts: DecorateRequestOptions,
    callback: BodyResponseCallback
  ): void;
  /**
   * Makes request and applies userProject query parameter if necessary.
   *
   * @private
   *
   * @param {object} reqOpts - The request options.
   * @param {function} callback - The callback function.
   */
  request(
    reqOpts: DecorateRequestOptions,
    callback?: BodyResponseCallback
  ): void | Promise<[ResponseBody, Metadata]> {
    return this.parent.request.call(this, reqOpts, callback!);
  }

  rotateEncryptionKey(
    options?: RotateEncryptionKeyOptions
  ): Promise<RotateEncryptionKeyResponse>;
  rotateEncryptionKey(callback: RotateEncryptionKeyCallback): void;
  rotateEncryptionKey(
    options: RotateEncryptionKeyOptions,
    callback: RotateEncryptionKeyCallback
  ): void;
  /**
   * @callback RotateEncryptionKeyCallback
   * @extends CopyCallback
   */
  /**
   * @typedef RotateEncryptionKeyResponse
   * @extends CopyResponse
   */
  /**
   * @param {string|buffer|object} RotateEncryptionKeyOptions Configuration options
   *     for File#rotateEncryptionKey().
   * If a string or Buffer is provided, it is interpreted as an AES-256,
   * customer-supplied encryption key. If you'd like to use a Cloud KMS key
   * name, you must specify an options object with the property name:
   * `kmsKeyName`.
   * @param {string|buffer} [options.encryptionKey] An AES-256 encryption key.
   * @param {string} [options.kmsKeyName] A Cloud KMS key name.
   */
  /**
   * This method allows you to update the encryption key associated with this
   * file.
   *
   * @see [Customer-supplied Encryption Keys]{@link https://cloud.google.com/storage/docs/encryption#customer-supplied}
   *
   * @param {RotateEncryptionKeyOptions} [options] - Configuration options.
   * @param {RotateEncryptionKeyCallback} [callback]
   * @returns {Promise<File>}
   *
   * @example <caption>include:samples/encryption.js</caption>
   * region_tag:storage_rotate_encryption_key
   * Example of rotating the encryption key for this file:
   */
  rotateEncryptionKey(
    optionsOrCallback?:
      | RotateEncryptionKeyOptions
      | RotateEncryptionKeyCallback,
    callback?: RotateEncryptionKeyCallback
  ): Promise<RotateEncryptionKeyResponse> | void {
    callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    let options: EncryptionKeyOptions = {};
    if (
      typeof optionsOrCallback === 'string' ||
      optionsOrCallback instanceof Buffer
    ) {
      options = {
        encryptionKey: optionsOrCallback,
      };
    } else if (typeof optionsOrCallback === 'object') {
      options = optionsOrCallback;
    }

    const newFile = this.bucket.file(this.id!, options);
    this.copy(newFile, callback!);
  }

  // tslint:disable:no-any
  save(data: any, options?: SaveOptions): Promise<void>;
  save(data: any, callback: SaveCallback): void;
  save(data: any, options: SaveOptions, callback: SaveCallback): void;
  /**
   * @typedef {object} SaveOptions
   * @extends CreateWriteStreamOptions
   */
  /**
   * @callback SaveCallback
   * @param {?Error} err Request error, if any.
   */
  /**
   * Write arbitrary data to a file.
   *
   * *This is a convenience method which wraps {@link File#createWriteStream}.*
   *
   * Resumable uploads are automatically enabled and must be shut off explicitly
   * by setting `options.resumable` to `false`.
   *
   * <p class="notice">
   *   There is some overhead when using a resumable upload that can cause
   *   noticeable performance degradation while uploading a series of small
   * files. When uploading files less than 10MB, it is recommended that the
   * resumable feature is disabled.
   * </p>
   *
   * @param {*} data The data to write to a file.
   * @param {SaveOptions} [options] See {@link File#createWriteStream}'s `options`
   *     parameter.
   * @param {SaveCallback} [callback] Callback function.
   * @returns {Promise}
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const myBucket = storage.bucket('my-bucket');
   *
   * const file = myBucket.file('my-file');
   * const contents = 'This is the contents of the file.';
   *
   * file.save(contents, function(err) {
   *   if (!err) {
   *     // File written successfully.
   *   }
   * });
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.save(contents).then(function() {});
   */
  save(
    data: any,
    optionsOrCallback?: SaveOptions | SaveCallback,
    callback?: SaveCallback
  ): Promise<void> | void {
    // tslint:enable:no-any
    callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    const options =
      typeof optionsOrCallback === 'object' ? optionsOrCallback : {};

    this.createWriteStream(options)
      .on('error', callback!)
      .on('finish', callback!)
      .end(data);
  }
  setStorageClass(
    storageClass: string,
    options?: SetStorageClassOptions
  ): Promise<SetStorageClassResponse>;
  setStorageClass(
    storageClass: string,
    options: SetStorageClassOptions,
    callback: SetStorageClassCallback
  ): void;
  setStorageClass(
    storageClass: string,
    callback?: SetStorageClassCallback
  ): void;
  /**
   * @typedef {array} SetStorageClassResponse
   * @property {object} 0 The full API response.
   */
  /**
   * @typedef {object} SetStorageClassOptions Configuration options for File#setStorageClass().
   * @property {string} [userProject] The ID of the project which will be
   *     billed for the request.
   */
  /**
   * @callback SetStorageClassCallback
   * @param {?Error} err Request error, if any.
   * @param {object} apiResponse The full API response.
   */
  /**
   * Set the storage class for this file.
   *
   * @see [Per-Object Storage Class]{@link https://cloud.google.com/storage/docs/per-object-storage-class}
   * @see [Storage Classes]{@link https://cloud.google.com/storage/docs/storage-classes}
   *
   * @param {string} storageClass The new storage class. (`multi_regional`,
   *     `regional`, `nearline`, `coldline`)
   * @param {SetStorageClassOptions} [options] Configuration options.
   * @param {string} [options.userProject] The ID of the project which will be
   *     billed for the request.
   * @param {SetStorageClassCallback} [callback] Callback function.
   * @returns {Promise<SetStorageClassResponse>}
   *
   * @example
   * file.setStorageClass('regional', function(err, apiResponse) {
   *   if (err) {
   *     // Error handling omitted.
   *   }
   *
   *   // The storage class was updated successfully.
   * });
   *
   * //-
   * // If the callback is omitted, we'll return a Promise.
   * //-
   * file.setStorageClass('regional').then(function() {});
   */
  setStorageClass(
    storageClass: string,
    optionsOrCallback?: SetStorageClassOptions | SetStorageClassCallback,
    callback?: SetStorageClassCallback
  ): Promise<SetStorageClassResponse> | void {
    callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    const options =
      typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
    const req = extend<SetStorageClassRequest, SetStorageClassOptions>(
      true,
      {},
      options
    );

    // In case we get input like `storageClass`, convert to `storage_class`.
    req.storageClass = storageClass
      .replace(/-/g, '_')
      .replace(/([a-z])([A-Z])/g, (_, low, up) => {
        return low + '_' + up;
      })
      .toUpperCase();

    this.copy(this, req, (err, file, apiResponse) => {
      if (err) {
        callback!(err, apiResponse!);
        return;
      }

      this.metadata = file!.metadata;

      callback!(null, apiResponse!);
    });
  }

  /**
   * Set a user project to be billed for all requests made from this File
   * object.
   *
   * @param {string} userProject The user project.
   *
   * @example
   * const {Storage} = require('@google-cloud/storage');
   * const storage = new Storage();
   * const bucket = storage.bucket('albums');
   * const file = bucket.file('my-file');
   *
   * file.setUserProject('grape-spaceship-123');
   */
  setUserProject(userProject: string): void {
    this.bucket.setUserProject.call(this, userProject);
  }

  /**
   * This creates a gcs-resumable-upload upload stream.
   *
   * @see [gcs-resumable-upload]{@link https://github.com/stephenplusplus/gcs-resumable-upload}
   *
   * @param {Duplexify} stream - Duplexify stream of data to pipe to the file.
   * @param {object=} options - Configuration object.
   *
   * @private
   */
  startResumableUpload_(
    dup: Duplexify,
    options: CreateResumableUploadOptions
  ): void {
    options = Object.assign(
      {
        metadata: {},
      },
      options
    );

    const uploadStream = resumableUpload.upload({
      authClient: this.storage.authClient,
      bucket: this.bucket.name,
      file: this.name,
      generation: this.generation,
      key: this.encryptionKey,
      kmsKeyName: this.kmsKeyName,
      metadata: options.metadata,
      offset: options.offset,
      predefinedAcl: options.predefinedAcl,
      private: options.private,
      public: options.public,
      uri: options.uri,
      userProject: options.userProject || this.userProject,
    });

    uploadStream
      .on('response', resp => {
        dup.emit('response', resp);
      })
      .on('metadata', metadata => {
        this.metadata = metadata;
      })
      .on('finish', () => {
        dup.emit('complete');
      });

    dup.setWritable(uploadStream);
  }

  /**
   * Takes a readable stream and pipes it to a remote file. Unlike
   * `startResumableUpload_`, which uses the resumable upload technique, this
   * method uses a simple upload (all or nothing).
   *
   * @param {Duplexify} dup - Duplexify stream of data to pipe to the file.
   * @param {object=} options - Configuration object.
   *
   * @private
   */
  startSimpleUpload_(
    dup: Duplexify,
    options?: CreateResumableUploadOptions
  ): void {
    options = Object.assign(
      {
        metadata: {},
      },
      options
    );

    const reqOpts: DecorateRequestOptions = {
      qs: {
        name: this.name,
      },
      uri: `${STORAGE_UPLOAD_BASE_URL}/${this.bucket.name}/o`,
    };

    if (this.generation !== undefined) {
      reqOpts.qs.ifGenerationMatch = this.generation;
    }

    if (this.kmsKeyName !== undefined) {
      reqOpts.qs.kmsKeyName = this.kmsKeyName;
    }

    if (options.userProject || this.userProject) {
      reqOpts.qs.userProject = options.userProject || this.userProject;
    }

    if (options.predefinedAcl) {
      reqOpts.qs.predefinedAcl = options.predefinedAcl;
    } else if (options.private) {
      reqOpts.qs.predefinedAcl = 'private';
    } else if (options.public) {
      reqOpts.qs.predefinedAcl = 'publicRead';
    }

    util.makeWritableStream(dup, {
      makeAuthenticatedRequest: (reqOpts: object) => {
        this.request(reqOpts as DecorateRequestOptions, (err, body, resp) => {
          if (err) {
            dup.destroy(err);
            return;
          }

          this.metadata = body;
          dup.emit('response', resp);
          dup.emit('complete');
        });
      },
      metadata: options.metadata,
      request: reqOpts,
    });
  }

  /**
   * Create canonical headers for signing v4 url.
   *
   * The canonical headers for v4-signing a request demands header names are
   * first lowercased, followed by sorting the header names.
   * Then, construct the canonical headers part of the request:
   *  <lowercasedHeaderName> + ":" + Trim(<value>) + "\n"
   *  ..
   *  <lowercasedHeaderName> + ":" + Trim(<value>) + "\n"
   *
   * @param headers
   * @private
   */
  private getCanonicalHeaders(headers: http.OutgoingHttpHeaders) {
    // Sort headers by their lowercased names
    const sortedHeaders = objectEntries(headers)
      // Convert header names to lowercase
      .map<[string, HeaderValue]>(([headerName, value]) => [
        headerName.toLowerCase(),
        value,
      ])
      .sort((a, b) => a[0].localeCompare(b[0]));

    return sortedHeaders
      .filter(([_, value]) => value !== undefined)
      .map(([headerName, value]) => {
        // - Convert Array (multi-valued header) into string, delimited by
        //      ',' (no space).
        // - Trim leading and trailing spaces.
        // - Convert sequential (2+) spaces into a single space
        const canonicalValue = `${value}`.trim().replace(/\s{2,}/g, ' ');

        return `${headerName}:${canonicalValue}\n`;
      })
      .join('');
  }
}

/*! Developer Documentation
 *
 * All async methods (except for streams) will return a Promise in the event
 * that a callback is omitted.
 */
promisifyAll(File, {
  exclude: [
    'request',
    'setEncryptionKey',
    'getSignedUrlV2',
    'getSignedUrlV4',
    'getCanonicalHeaders',
    'getDate',
  ],
});

/**
 * Reference to the {@link File} class.
 * @name module:@google-cloud/storage.File
 * @see File
 */
export {File};
