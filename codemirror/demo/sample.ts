// The document the editor opens with.

export const sample = `# Building up and naming trees
const = \\a \\b a # desugars to △ △
false = △
true = △ △
not = △ (△ true (const false)) △
not true
not false

# Reflecting on definitions with help of a library functions...
Serialize.to_source true
size true
Serialize.to_source not
size not
# ... that are themselves just trees
Serialize.to_source Serialize.to_source
size size

# More powerful library functions -- still nothing but trees!
size Qr.svg_of_string
file "qr.svg" "image/svg+xml" $ Qr.svg_of_string "https://treecalcul.us/"

# Syntax medley
map_of_examples =
  { "lambda": \\n Nat.double n n # desugars via abstraction elimination
  , "natural number": 42 # desugars into list of bools (LSB first)
  , "character": '🤡' # desugars to natural number (unicode code point)
  , "string": "🤡 party" # desugars to list of characters
  , "list": [ id, 123 ] # desugars into (△ id (△ 123 (△ ...)))
  , id: size # anything can be a key in maps
  }
List.length (Map.entries map_of_examples)
List.length $ Map.entries map_of_examples

# Uppercase names are interpreted as algebraic data types
Shape = Circle radius | Rect width height
# ... and desugared as Scott encodings, making elimination as simple as:
shape_to_string = \\shape shape
  (\\r List.concat_list [ "Circle ", Nat.to_string r ])
  (\\w \\h List.concat_list [ "Rect ", Nat.to_string w, " ", Nat.to_string h ])
shape_to_string $ Circle 5
shape_to_string $ Rect 3 4

# Error handling
line with unresolved symbols
line with invalid syntax :(
`;
