import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {

  buildReplySubject,

  formatReplySubject,

  replySubjectBase,

  resolveAutoReplyRecipient,

} from "./mail-reply-subject.ts";



Deno.test("replySubjectBase prefers subject", () => {

  assertEquals(

    replySubjectBase({ subject: "  Need help  ", from_email: "a@b.com" }),

    "Need help",

  );

});



Deno.test("replySubjectBase falls back to auto-reply recipient when subject empty", () => {

  assertEquals(

    replySubjectBase({

      subject: "",

      from_email: "boway019@gmail.com",

    }),

    "boway019@gmail.com",

  );

  assertEquals(

    replySubjectBase({

      subject: "   ",

      from_email: "boway019@gmail.com",

    }),

    "boway019@gmail.com",

  );

});



Deno.test("replySubjectBase does not use incoming to_email (mailbox address)", () => {

  assertEquals(

    replySubjectBase({

      subject: "",

      from_email: "boway019@gmail.com",

    }, "boway019@gmail.com"),

    "boway019@gmail.com",

  );

});



Deno.test("replySubjectBase treats To: placeholder as empty subject", () => {

  assertEquals(

    replySubjectBase({

      subject: "To: caobaowei123@163.com",

      from_email: "boway019@gmail.com",

    }),

    "boway019@gmail.com",

  );

});



Deno.test("resolveAutoReplyRecipient prefers explicit replyToEmail", () => {

  assertEquals(

    resolveAutoReplyRecipient({ from_email: "old@example.com" }, "new@example.com"),

    "new@example.com",

  );

});



Deno.test("formatReplySubject adds Re prefix once", () => {

  assertEquals(formatReplySubject("Need help"), "Re: Need help");

  assertEquals(formatReplySubject("Re: Need help"), "Re: Need help");

  assertEquals(formatReplySubject("RE: Need help"), "RE: Need help");

});



Deno.test("buildReplySubject for no-subject reply uses auto-reply recipient", () => {

  assertEquals(

    buildReplySubject({

      subject: "",

      from_email: "boway019@gmail.com",

    }),

    "Re: boway019@gmail.com",

  );

  assertEquals(

    buildReplySubject({

      subject: "To: caobaowei123@163.com",

      from_email: "caobaowei123@gmail.com",

    }),

    "Re: caobaowei123@gmail.com",

  );

});


