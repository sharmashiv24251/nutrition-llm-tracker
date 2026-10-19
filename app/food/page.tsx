import { Suspense } from "react";
import { ChatScreen } from "@/components/ChatScreen";

export default function Page() {
  // ChatScreen reads ?prefill= (from "Add to this day") at request time.
  return (
    <Suspense>
      <ChatScreen mode="food" />
    </Suspense>
  );
}
