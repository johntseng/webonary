/**
 * @api {get} /search/entry/:dictionaryId Search dictionary entries
 * @apiName SearchDictionaryEntries
 * @apiDescription Searches the dictionary for entries that match. Returns an array of DictionaryEntryItem's.
 * (https://github.com/sillsdev/webonary/blob/develop/webonary-cloud-api/lambda/entry.model.ts)
 * @apiGroup Dictionary
 * @apiUse DictionaryIdPath
 * @apiParam {String} text
 * @apiParam {String} [mainLang] Main language of the dictionary, used for setting the db locale.
 * @apiParam {String} [lang] Language to search through.
 * @apiParam {String} [partOfSpeech] Filter results by part of speech.
 * @apiParam {Number=0,1} [matchPartial] 1 to allow partial matches, and 0 otherwise. Defaults to 0.
 * @apiParam {Number=0,1} [matchAccents] 1 to match accents, and 0 otherwise. Defaults to 0.
 * @apiParam {String} [semDomAbbrev] Filter by semantic domain abbreviation.
 * @apiParam {String} [searchSemDoms] 1 to search by semantic domains, and 0 otherwise. Defaults to 0.
 * @apiParam {Number=0,1} [countTotalOnly] 1 to return only the count, and 0 otherwise. Defaults to 0.
 * @apiParam {Number} [pageNumber] 1-indexed page number for the results. Defaults to 1.
 * @apiParam {Number} [pageLimit] Number of entries per page. Max is 100. Defaults to 100.
 *
 * @apiError (404) NotFound There are no matching entries.
 */

import { APIGatewayEvent, Context, Callback } from 'aws-lambda';
import { MongoClient } from 'mongodb';
import { connectToDB } from './mongo';
import {
  DB_NAME,
  DB_COLLECTION_DICTIONARY_ENTRIES,
  DB_MAX_DOCUMENTS_PER_CALL,
  DB_COLLATION_LOCALE_DEFAULT_FOR_INSENSITIVITY,
  DB_COLLATION_STRENGTH_FOR_CASE_INSENSITIVITY,
  DB_COLLATION_STRENGTH_FOR_SENSITIVITY,
  DB_COLLATION_LOCALES,
} from './db';
import { DbFindParameters } from './base.model';
import { DbPaths } from './entry.model';
import { getDbSkip } from './utils';

import * as Response from './response';

export interface SearchEntriesArguments {
  pageNumber: number;
  pageLimit: number;
  dictionaryId: string | undefined;
  searchSemDoms: string | undefined;
  semDomAbbrev: string | undefined;
  lang: string | undefined;
  text: string;
  countTotalOnly: string | undefined;
  partOfSpeech: string | undefined;
  mainLang: string | undefined;
  matchPartial: string | undefined;
  matchAccents: string | undefined;
  $language: string;
}

export async function searchEntries(args: SearchEntriesArguments): Promise<Response.Response> {
  try {
    const dbClient: MongoClient = await connectToDB();
    const db = dbClient.db(DB_NAME);

    // set up main search
    let entries;
    let locale = DB_COLLATION_LOCALE_DEFAULT_FOR_INSENSITIVITY;
    let strength = DB_COLLATION_STRENGTH_FOR_CASE_INSENSITIVITY;
    const dbSkip = getDbSkip(args.pageNumber, args.pageLimit);
    const primaryFilter: DbFindParameters = { dictionaryId: args.dictionaryId };

    // Semantic domains search
    if (args.searchSemDoms === '1') {
      let dbFind;
      if (args.semDomAbbrev && args.semDomAbbrev !== '') {
        const abbreviationRegex = {
          $in: [args.semDomAbbrev, new RegExp(`^${args.semDomAbbrev}.`)],
        };
        if (args.lang) {
          dbFind = {
            ...primaryFilter,
            [DbPaths.ENTRY_SEM_DOMS_ABBREV]: {
              $elemMatch: {
                lang: args.lang,
                value: abbreviationRegex,
              },
            },
          };
        } else {
          dbFind = {
            ...primaryFilter,
            [DbPaths.ENTRY_SEM_DOMS_ABBREV_VALUE]: abbreviationRegex,
          };
        }
      } else {
        dbFind = { ...primaryFilter, [DbPaths.ENTRY_SEM_DOMS_NAME_VALUE]: args.text };
      }

      if (args.countTotalOnly === '1') {
        const count = await db.collection(DB_COLLECTION_DICTIONARY_ENTRIES).countDocuments(dbFind);
        return Response.success({ count });
      }

      entries = await db
        .collection(DB_COLLECTION_DICTIONARY_ENTRIES)
        .find(dbFind)
        .skip(dbSkip)
        .limit(args.pageLimit)
        .toArray();

      return Response.success(entries);
    }

    let langFilter: DbFindParameters;
    const regexFilter: DbFindParameters = { $regex: args.text, $options: 'i' };

    if (args.partOfSpeech) {
      primaryFilter[DbPaths.ENTRY_PART_OF_SPEECH_VALUE] = args.partOfSpeech;
    }

    if (args.lang) {
      if (DB_COLLATION_LOCALES.includes(args.lang)) {
        locale = args.lang;
      }

      let langFieldToFilter: string;
      if (args.mainLang && args.mainLang === args.lang) {
        langFieldToFilter = 'mainHeadWord';
      } else {
        langFieldToFilter = 'senses.definitionOrGloss';
      }

      langFilter = {
        [langFieldToFilter]: {
          $elemMatch: {
            lang: args.lang,
            value: regexFilter,
          },
        },
      };
    } else {
      langFilter = {
        $or: [
          { [DbPaths.ENTRY_MAIN_HEADWORD_VALUE]: regexFilter },
          { [DbPaths.ENTRY_DEFINITION_VALUE]: regexFilter },
        ],
      };
    }

    if (args.matchPartial === '1') {
      const dictionaryPartialSearch = {
        $and: [primaryFilter, langFilter],
      };

      if (args.matchAccents === '1') {
        strength = DB_COLLATION_STRENGTH_FOR_SENSITIVITY;
      }

      console.log(
        `Searching ${
          args.dictionaryId
        } using partial match and locale ${locale} and strength ${strength} ${JSON.stringify(
          dictionaryPartialSearch,
        )}`,
      );

      if (args.countTotalOnly === '1') {
        // TODO: countDocuments might not be 100%, but should be more than the actual count, so it would page to the end
        const count = await db
          .collection(DB_COLLECTION_DICTIONARY_ENTRIES)
          .countDocuments(dictionaryPartialSearch);

        return Response.success({ count });
      }

      entries = await db
        .collection(DB_COLLECTION_DICTIONARY_ENTRIES)
        .find(dictionaryPartialSearch)
        .collation({ locale, strength })
        .skip(dbSkip)
        .limit(args.pageLimit)
        .toArray();
    } else {
      // NOTE: Mongo text search can do language specific stemming,
      // but then each search much specify correct language in a field named "language".
      // To use this, we will need to distinguish between lang field in Entry, and a special language field
      // that is one of the valid Mongo values, or "none".
      // By setting $language: "none" in all queries and in index, we are skipping language-specific stemming.
      // If we wanted to use language stemming, then we must specify language in each search,
      // and UNION all searches if language-independent search is desired
      const $diacriticSensitive = args.matchAccents === '1';
      const $text = { $search: `"${args.text}"`, $language: args.$language, $diacriticSensitive };
      const dictionaryFulltextSearch = { ...primaryFilter, $text };
      if (args.lang) {
        const dbFind = [{ $match: dictionaryFulltextSearch }, { $match: langFilter }];

        console.log(`Searching ${args.dictionaryId} using fulltext ${JSON.stringify(dbFind)}`);

        if (args.countTotalOnly === '1') {
          /* TODO: There might be a way to count docs in aggregation, but I have not figured it out yet...
          const count = await db.collection(DB_COLLECTION_ENTRIES).countDocuments(dbFind);
          */
          entries = await db
            .collection(DB_COLLECTION_DICTIONARY_ENTRIES)
            .aggregate(dbFind)
            .toArray();
          const count = entries.length;

          return Response.success({ count });
        }

        entries = await db
          .collection(DB_COLLECTION_DICTIONARY_ENTRIES)
          .aggregate(dbFind)
          .skip(dbSkip)
          .limit(args.pageLimit)
          .toArray();
      } else {
        console.log(
          `Searching ${args.dictionaryId} using ${JSON.stringify(dictionaryFulltextSearch)}`,
        );

        if (args.countTotalOnly === '1') {
          const count = await db
            .collection(DB_COLLECTION_DICTIONARY_ENTRIES)
            .countDocuments(dictionaryFulltextSearch);

          return Response.success({ count });
        }

        entries = await db
          .collection(DB_COLLECTION_DICTIONARY_ENTRIES)
          .find(dictionaryFulltextSearch)
          .skip(dbSkip)
          .limit(args.pageLimit)
          .toArray();
      }
    }

    if (!entries.length) {
      return Response.notFound([{}]);
    }
    return Response.success(entries);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.log(error);
    return Response.failure({ errorType: error.name, errorMessage: error.message });
  }
}

export async function handler(
  event: APIGatewayEvent,
  context: Context,
  callback: Callback,
): Promise<void> {
  // eslint-disable-next-line no-param-reassign
  context.callbackWaitsForEmptyEventLoop = false;

  const dictionaryId = event.pathParameters?.dictionaryId;
  const text = event.queryStringParameters?.text;
  const mainLang = event.queryStringParameters?.mainLang; // main language of the dictionary
  const lang = event.queryStringParameters?.lang; // this is used to limit which language to search

  const partOfSpeech = event.queryStringParameters?.partOfSpeech;
  const matchPartial = event.queryStringParameters?.matchPartial;
  const matchAccents = event.queryStringParameters?.matchAccents; // NOTE: matching accent works only for fulltext searching

  const semDomAbbrev = event.queryStringParameters?.semDomAbbrev;
  const searchSemDoms = event.queryStringParameters?.searchSemDoms;

  const countTotalOnly = event.queryStringParameters?.countTotalOnly;
  const $language = event.queryStringParameters?.stemmingLanguage ?? 'none';

  const pageNumber = Math.max(Number(event.queryStringParameters?.pageNumber ?? '1'), 1);
  const pageLimit = Math.min(
    Math.max(Number(event.queryStringParameters?.pageLimit ?? DB_MAX_DOCUMENTS_PER_CALL), 1),
    DB_MAX_DOCUMENTS_PER_CALL,
  );

  if (!text) {
    return callback(null, Response.badRequest('Search text must be specified.'));
  }
  const response = await searchEntries({
    pageNumber,
    pageLimit,
    dictionaryId,
    searchSemDoms,
    semDomAbbrev,
    lang,
    text,
    countTotalOnly,
    partOfSpeech,
    mainLang,
    matchPartial,
    matchAccents,
    $language,
  });

  return callback(null, response);
}

export default handler;
