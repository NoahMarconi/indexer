/* eslint-disable @typescript-eslint/no-explicit-any */

import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { config } from "@/config/index";
import _ from "lodash";
import { collectionMetadataQueueJob } from "@/jobs/collection-updates/collection-metadata-queue-job";
import { Tokens } from "@/models/tokens";

const QUEUE_NAME = "backfill-refresh-collections-metadata";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 1000,
    removeOnFail: 10000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      let cursor = job.data.cursor as CursorInfo;
      let continuationFilter = "";

      const limit = (await redis.get(`${QUEUE_NAME}-limit`)) || 10000;

      if (!cursor) {
        const cursorJson = await redis.get(`${QUEUE_NAME}-next-cursor`);

        if (cursorJson) {
          cursor = JSON.parse(cursorJson);
        }
      }

      if (cursor) {
        continuationFilter = `WHERE (collections.id) > ($/collectionId/)`;
      }

      const results = await idb.manyOrNone(
        `
        SELECT collections.id
        FROM collections
        --${continuationFilter}
        ORDER BY all_time_volume DESC
        LIMIT $/limit/
          `,
        {
          collectionId: cursor?.collectionId,
          limit,
        }
      );

      let nextCursor;
      const collectionMetadataInfos = [];

      if (results.length) {
        for (const result of results) {
          const tokenId = await Tokens.getSingleToken(result.id);
          collectionMetadataInfos.push({
            contract: result.id,
            tokenId,
            community: "",
          });
        }

        await collectionMetadataQueueJob.addToQueueBulk(collectionMetadataInfos);
      }

      if (results.length == limit) {
        const lastResult = _.last(results);

        nextCursor = {
          collectionId: lastResult.id,
        };

        await redis.set(`${QUEUE_NAME}-next-cursor`, JSON.stringify(nextCursor));

        // await addToQueue(nextCursor);
      }
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export type CursorInfo = {
  collectionId: string;
};

export const addToQueue = async (cursor?: CursorInfo) => {
  await queue.add(randomUUID(), { cursor });
};
