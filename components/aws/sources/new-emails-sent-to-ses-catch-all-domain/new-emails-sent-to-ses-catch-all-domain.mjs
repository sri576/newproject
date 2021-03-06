import { v4 as uuid } from "uuid";
import base from "../common/ses.mjs";
import { toSingleLineString } from "../common/utils.mjs";
import { MailParser } from "mailparser-mit";

export default {
  ...base,
  key: "aws-new-emails-sent-to-ses-catch-all-domain",
  name: "New Inbound SES Emails",
  description: toSingleLineString(`
    The source subscribes to all emails delivered to a
    specific domain configured in AWS SES.
    When an email is sent to any address at the domain,
    this event source emits that email as a formatted event.
    These events can trigger a Pipedream workflow and can be consumed via SSE or REST API.
  `),
  type: "source",
  version: "1.0.3",
  props: {
    ...base.props,
    domain: {
      label: "SES Domain",
      description: "The domain you'd like to configure a catch-all handler for",
      type: "string",
      options() {
        return this.sesIdentities();
      },
    },
  },
  methods: {
    ...base.methods,
    getReceiptRule(bucketName, topicArn) {
      const name = `pd-catchall-${uuid()}`;
      const rule = {
        Name: name,
        Enabled: true,
        Actions: [
          {
            S3Action: {
              TopicArn: topicArn,
              BucketName: bucketName,
            },
          },
        ],
        Recipients: [
          this.domain,
        ],
        ScanEnabled: true,
      };
      return {
        name,
        rule,
      };
    },
    async processEvent(event) {
      const { body } = event;
      const { Message: rawMessage } = body;
      if (!rawMessage) {
        console.log("No message present, exiting");
        return;
      }

      const { "x-amz-sns-message-id": id } = event.headers;
      const { Timestamp: ts } = event.body;
      const meta = {
        id,
        ts,
      };

      try {
        const message = JSON.parse(rawMessage);
        const {
          bucketName: Bucket,
          objectKey: Key,
        } = message?.receipt?.action;
        const { Body } = await this.aws._getS3Client(this.getRegion()).getObject({
          Bucket,
          Key,
        })
          .promise();
        const parsed = await new Promise((resolve) => {
          const mailparser = new MailParser();
          mailparser.on("end", resolve);
          mailparser.write(Body);
          mailparser.end();
        });
        for (const attachment of parsed.attachments || []) {
          if (!attachment.content) continue;
          attachment.content_b64 = attachment.content.toString("base64");
          delete attachment.content;
        }

        // Emit to the default channel
        this.$emit(parsed, {
          id,
          summary: parsed.subject,
          ts,
        });

        // and a channel specific to the email address
        const address = parsed.to?.[0]?.address;
        if (address) {
          this.$emit(parsed, {
            id,
            name: address,
            summary: parsed.subject,
            ts,
          });
        }
      } catch (err) {
        console.log(
          `Couldn't parse message. Emitting raw message. Error: ${err}`,
        );
        this.$emit({
          rawMessage,
        }, {
          ...meta,
          summary: "Couldn't parse message",
        });
      }
    },
  },
};
