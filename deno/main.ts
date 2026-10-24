import {createDenoFxRelay} from './fx-relay.js';
Deno.serve(createDenoFxRelay({secret:Deno.env.get('RELAY_SECRET')}));
