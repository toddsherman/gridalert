import { redirect } from 'next/navigation';

// How it works is part of the home page now. Old links land on it.
export default function HowPage() {
  redirect('/#how');
}
