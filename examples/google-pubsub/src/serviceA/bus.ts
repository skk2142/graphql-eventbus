import fs from "fs";
import path from "path";
import { eventHandlers } from "./eventHandlers";
import { EventHandlers } from "./generated/codegen-event-consumer";
import gql from "graphql-tag";
import { Publish } from "./generated/codegen-event-publisher";
import {
  PubSubEventBus,
  PubSubEventBusConfig,
} from "../PubSubEventBus";
import { EventBusSubscriberCb } from "graphql-eventbus-core";
import { getSchema } from "../utils";
import {
  RabbitMQEventBus,
  RabbitMQEventBusConfig,
} from "../RabbitMQEventBus";

export type MessageHandlerContext = {
  logger: (...data: any[]) => void;
};

export const messageHandlers: EventBusSubscriberCb = async (args) => {
  const handler = eventHandlers[args.topic as keyof EventHandlers];
  if (!handler) {
    throw new Error(`Handler for message ${args.topic} not found`);
  }
  const context: MessageHandlerContext = {
    logger: console.log,
  };
  await handler(args.payload as any, context);
};

export const getPublish = () => {
  const publish: Publish = (data) => {
    return eventBus.publish({
      payload: data.payload,
      topic: data.event,
    });
  };
  return publish;
};

export const eventConsumerTypeDef = fs.readFileSync(
  path.join(__dirname, "./event-consumer.graphql"),
  "utf-8"
);

export const eventbusConfig: RabbitMQEventBusConfig = {
  serviceName: "serviceA",
  publisher: {
    schema: getSchema(path.join(__dirname, "schema-event.graphql")),
  },
  subscriber: {
    cb: messageHandlers,
    queries: gql`
      ${eventConsumerTypeDef}
    `,
    schema: getSchema(
      path.join(__dirname, "generated/publisher.graphql")
    ),
  },
};

export const eventBus = new RabbitMQEventBus(eventbusConfig);
// export const eventBus = new PubSubEventBus(eventbusConfig);

let isInitialized = false;

export const initServiceAEventBus = async () => {
  if (!isInitialized) {
    await eventBus.init();
    isInitialized = true;
  }
  return eventBus;
};
