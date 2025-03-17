# LambAda

LambAda is lightweight syntactic sugar for writing programs using minimal calculi.
[The interactive tree calculus playground](https://treecalcul.us/live/) uses LambAda
and this repo focuses on writing programs in [tree calculus, specifically _triage calculus_](https://treecalcul.us/specification/).

## Examples
```
id = \x x
```
This defines an identity function and gives it name `id`. `\x x` is notation for $λx.x$ and will desugar based on the underlying calculus, e.g. `△ (△ (△ △)) △` or `△ (△ △ △) △` in case of tree calculus, where `△` is assumed to be provided/interpreted by the runtime ultimately executing things.
```
map = \f fix $ \self match_list [] (\hd \tl cons (f hd) (self tl))
```
This defines `map`, assuming that `fix`, `match_list` and `cons` are already defined. LambAda itself does _not_ predefine any names and only desugars constructs like lambdas, lists, etc into their equivalent combinations of the underlying calculus.
```
map id "hello world"
```
This is the application of `map` to `id` and some string. Assuming `map` and `id` are (fully) defined, and after desugaring the string into a low-level representation, whatever LambAda emits will be ready for reduction according the rules of some underlying calculus.

Check out [the playground](https://treecalcul.us/live/) and [website](https://treecalcul.us/) for fully functional examples.

