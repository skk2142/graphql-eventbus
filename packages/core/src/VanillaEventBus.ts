import { EventBusValidator } from "./EventBusValidator";
import { EventBusSubscriberCb } from "./EventBus";
import { getRootQueryFields } from "./eventbus-utils";
import { DocumentNode, GraphQLSchema } from "graphql";
import { InvalidPublishTopic } from ".";
import { v4 } from "uuid";
import { isPresent } from "ts-is-present";

export type DataCb = (baggage: Baggage) => Promise<unknown>;

interface SubscriptionConfig {
  queries: DocumentNode;
  schema: GraphQLSchema;
  cb: EventBusSubscriberCb;
  getSubscription: (topic: string, cb: DataCb) => void;
}

export interface Baggage {
  payload: {};
  metadata: Metadata;
}

type OptionalPromise<T> = T | Promise<T> | undefined | null | void;

export type ConsumeEndHook = () => OptionalPromise<unknown>;

export type ConsumeSuccessHook = () => OptionalPromise<unknown>;

export type ConsumeErrorHook = (
  error: Error
) => OptionalPromise<unknown>;

export type ConsumeStartHook = (args: {
  topic: string;
  fullData: {};
  documentNode: DocumentNode;
  metadata: Metadata;
}) => OptionalPromise<{
  consumeEndHook?: ConsumeEndHook;
  consumeErrorHook?: ConsumeErrorHook;
  consumeSuccessHook?: ConsumeSuccessHook;
}>;

export type PublishEndHook = () => OptionalPromise<unknown>;

export type PublishSuccessHook = () => OptionalPromise<unknown>;

export type PublishErrorHook = (
  error: Error
) => OptionalPromise<unknown>;

export type PublishStartHook = (args: {
  topic: string;
  payload: {};
  metadata: Metadata;
}) => OptionalPromise<{
  publishEndHook?: PublishEndHook;
  publishErrorHook?: PublishErrorHook;
  publishSuccessHook?: PublishSuccessHook;
}>;

export interface EventBusPlugin {
  consumeStartHook?: ConsumeStartHook;
  publishStartHook?: PublishStartHook;
}

export interface Metadata {
  "x-request-id": string;
  publishTime: string;
  messageId: string;
  [key: string]: string;
}

export class VanillaEventBus {
  private consumeValidator!: EventBusValidator | null;
  private publishValidator!: EventBusValidator | null;
  constructor(
    public config: {
      publisher?: {
        schema: GraphQLSchema;
        publishInit?: (topics: string[]) => Promise<unknown>;
        publish: (args: {
          topic: string;
          baggage: Baggage;
        }) => Promise<unknown>;
        allowInvalidTopic?: boolean;
      };
      subscriber?: SubscriptionConfig;
      plugins?: EventBusPlugin[];
    }
  ) {
    if (config.publisher) {
      this.publishValidator = new EventBusValidator({
        publisherSchema: config.publisher.schema,
      });
    }
    if (config.subscriber) {
      this.consumeValidator = new EventBusValidator({
        publisherSchema: config.subscriber.schema,
      });
    }
  }

  init = async () => {
    if (this.config.publisher && this.config.publisher.publishInit) {
      const topicnames = getRootQueryFields(
        this.config.publisher.schema
      );
      await this.config.publisher.publishInit(topicnames);
    }
    if (this.config.subscriber) {
      await this.consume(this.config.subscriber);
    }
  };

  private consume = async (args: SubscriptionConfig) => {
    if (!this.consumeValidator) {
      throw new Error("Subscriber config not added");
    }
    const consumeHooks =
      this.config.plugins
        ?.map((a) => a.consumeStartHook)
        .filter(isPresent) || [];
    await this.consumeValidator
      .validateConsumerQueries(args.queries)
      .then((topics) => {
        topics.forEach(async (topic) => {
          await args.getSubscription(
            topic,
            async ({ metadata, payload: fullData }: Baggage) => {
              let consumeEndHooks: ConsumeEndHook[] = [];
              let consumeErrorHooks: ConsumeErrorHook[] = [];
              let consumeSuccessHooks: ConsumeSuccessHook[] = [];
              if (consumeHooks.length) {
                await Promise.all(
                  consumeHooks.map(async (hook) => {
                    const foo = await hook({
                      topic,
                      metadata,
                      fullData,
                      documentNode: this.consumeValidator!.getDocumentForTopic(
                        topic
                      ),
                    });
                    if (!foo) {
                      return;
                    }
                    if (foo.consumeEndHook) {
                      consumeEndHooks.push(foo.consumeEndHook);
                    }
                    if (foo.consumeSuccessHook) {
                      consumeSuccessHooks.push(
                        foo.consumeSuccessHook
                      );
                    }
                    if (foo.consumeErrorHook) {
                      consumeErrorHooks.push(foo.consumeErrorHook);
                    }
                  })
                );
              }
              try {
                const payload = await this.consumeValidator?.extractData(
                  {
                    topic,
                    data: fullData,
                  }
                );
                await args.cb({
                  topic: topic,
                  payload,
                  metadata,
                  fullData,
                });
                if (consumeSuccessHooks.length) {
                  await Promise.all(
                    consumeSuccessHooks.map((hook) => {
                      return hook();
                    })
                  );
                }
              } catch (e) {
                if (consumeErrorHooks.length) {
                  await Promise.all(
                    consumeErrorHooks.map((hook) => {
                      return hook(e as Error);
                    })
                  );
                }
                throw e;
              } finally {
                if (consumeEndHooks.length) {
                  await Promise.all(
                    consumeEndHooks.map((hook) => {
                      return hook();
                    })
                  );
                }
              }
            }
          );
        });
      });
  };

  publish = async (props: {
    topic: string;
    payload: {};
    metadata?: Partial<Metadata>;
  }) => {
    if (!this.publishValidator) {
      throw new Error("Publish config not added!");
    }
    const metadata: Metadata = {
      "x-request-id": v4(),
      ...props.metadata,
      messageId: v4(),
      publishTime: new Date().toISOString(),
    };
    const publishHooks =
      this.config.plugins
        ?.map((a) => a.publishStartHook)
        .filter(isPresent) || [];
    let publishEndHooks: PublishEndHook[] = [];
    let publishErrorHooks: PublishErrorHook[] = [];
    let publishSuccessHooks: PublishSuccessHook[] = [];
    if (publishHooks.length) {
      await publishHooks.map(async (hook) => {
        const r = await hook({
          topic: props.topic,
          payload: props.payload,
          metadata,
        });
        if (!r) {
          return;
        }
        if (r.publishEndHook) {
          publishEndHooks.push(r.publishEndHook);
        }
        if (r.publishSuccessHook) {
          publishSuccessHooks.push(r.publishSuccessHook);
        }
        if (r.publishErrorHook) {
          publishErrorHooks.push(r.publishErrorHook);
        }
      });
    }
    try {
      await this.publishValidator.publishValidate(props);
      await this.config.publisher?.publish({
        topic: props.topic,
        baggage: {
          metadata,
          payload: props.payload,
        },
      });
      if (publishSuccessHooks.length) {
        await Promise.all(
          publishSuccessHooks.map((hook) => {
            return hook();
          })
        );
      }
    } catch (e) {
      if (publishErrorHooks.length) {
        await Promise.all(
          publishErrorHooks.map((hook) => {
            return hook(e as Error);
          })
        );
      }
      if (
        e instanceof InvalidPublishTopic &&
        this.config.publisher?.allowInvalidTopic
      ) {
        return;
      }
      throw e;
    } finally {
      if (publishEndHooks.length) {
        await Promise.all(
          publishEndHooks.map((hook) => {
            return hook();
          })
        );
      }
    }
    return;
  };
}
